import zstdlib from "../zstd-wasm-compress/bin/zstdlib.js";
import zstdwasm from "../zstd-wasm-compress/bin/zstdlib.wasm";

const dictionaryPath = "/dictionary/";

// Dictionary options
const match = 'match="/*", match-dest=("document" "frame")'; // Match pattern for the URLs to be compressed
const dictionaryExpiration = 30 * 24 * 3600;                 // 30 day expiration on the dictionary itself

// Compression options
const compressionLevel = 10;
const compressionWindowLog = 22;  // Compression window should be at least as long as the dictionary + typical response - 2 ^ 22 = 4MB

// Proxied sites and their dictionaries
const SITES = {
  "etsy.patrickmeenan.com": {"dictionary": "/etsy.dat", "origin": "www.etsy.com"},
  "cnn.patrickmeenan.com": {"dictionary": "/cnn.dat", "origin": "www.cnn.com"},
  "roe.patrickmeenan.com": {"dictionary": "/roe.dat", "origin": "roe.dev"},
  "nuxt.patrickmeenan.com": {"dictionary": "/nuxt.dat", "origin": "nuxt.com"},
  "ray-ban.patrickmeenan.com": {"dictionary": "/ray-ban.dat", "origin": "www.ray-ban.com"},
}

// Internal globals for managing state while waiting for the dictionary and zstd wasm to load
let zstd = null;
let brotli = null;
let wasm = null;
let wasmLoaded = null;
const dictionaries = {};  // in-memory dictionaries, indexed by ID
const bufferSize = 10240; // 10k malloc buffers for response chunks (usually 4kb max)
const buffers = [];       // Spare buffers

const robots = `User-agent: *
Disallow: /
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const origin = host in SITES ? SITES[host].origin : host;

    const headers = [];
    const dest = request.headers.get("sec-fetch-dest");
    addLinkHeaders(request, headers, host);

    // Handle the request for the dictionary itself
    const isDictionary = url.pathname.startsWith(dictionaryPath);
    if (isDictionary) {
      return await fetchDictionary(env, request);
    } else if (url.pathname == '/robots.txt') {
      return new Response(robots, {headers: {"content-type": "text/plain"}});
    } else if (dest && ["document", "frame"].includes(dest)) {
      url.hostname = origin;
      headers.push(["Vary", "Available-Dictionary"]);
      if (request.headers.get("available-dictionary") && request.headers.get("dictionary-id")) {
        // Trigger the async dictionary load
        const dictionaryPromise = loadDictionary(request, env, ctx).catch(E => console.log(E));
        const original = await fetch(url.toString(), request);
        const dictionary = await dictionaryPromise;

        if (original.status == 200) {
          if (dictionary !== null) {
            const response = compressResponse(original, dictionary, headers, ctx, host, origin);
            return response;
          } else {
            let location = original.headers.get("location");
            if (location) {
              const response = new Response(original.body, original);
              location = location.replaceAll(origin, host);
              response.headers.set("location", location);
              return response;
            } else {
              return rewriteResponse(ctx, original, headers, host, origin);
            }
          }
        } else {
          url.hostname = origin;
          const original = await fetch(url.toString(), request);
          return addHeaders(original, headers);
        }
      } else {
        const original = await fetch(url.toString(), request);
        return rewriteResponse(ctx, original, headers, host, origin);
      }
    } else {
      url.hostname = origin;
      const original = await fetch(url.toString(), request);
      return addHeaders(original, headers);
    }
  }
}

function addHeaders(original, headers, origin, host) {
  const response = new Response(original.body, original);
  for (const header of headers) {
    response.headers.append(header[0], header[1]);
  }
  let location = response.headers.get("location");
  if (location) {
    location = location.replaceAll(origin, host);
    response.headers.set("location", location);
  }
  return response;
}

// Rewrite URLs in the original response
function rewriteResponse(ctx, original, headers, host, origin) {
  const { readable, writable } = new TransformStream();
  const response = new Response(readable, original);
  for (const header of headers) {
    response.headers.append(header[0], header[1]);
  }
  let location = response.headers.get("location");
  if (location) {
    location = location.replaceAll(origin, host);
    response.headers.set("location", location);
  }
  ctx.waitUntil(rewriteHtml(original, writable, host, origin));
  return response;
}

async function rewriteHtml(original, writable, host, origin) {
  const reader = original.body.getReader();
  const writer = writable.getWriter();
  const contentType = original.headers.get("content-type");

  while (true) {
    let { value, done } = await reader.read();
    if (done) break;

    // rewrite the URLs for HTML content
    if (contentType && contentType.indexOf("text/html") !== -1) {
      let html = new TextDecoder().decode(value);
      html = html.replaceAll(origin, host);
      // Make sure not to rewrite the canonical URL for the page
      html = html.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://' + origin);
      html = html.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://' + origin);
      value = new TextEncoder().encode(html);
    }

    await writer.write(value);
  }

  await writer.close();
}

// Add the Link headers for all dynamic_dictionaries to any document or frame requests
function addLinkHeaders(request, headers, host) {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest && ["document", "frame"].includes(dest) && !request.headers.get("available-dictionary")) {
    if (host in SITES && "dictionary" in SITES[host]) {
      headers.push(["Link", '<' + dictionaryPath + host + '>; rel="compression-dictionary"']);
    }
  }
}
/*
  Dictionary-compress the response
*/
function compressResponse(original, dictionary, headers, ctx, host, origin) {
  const { readable, writable } = new TransformStream();

  const init = {
    "cf": original.cf,
    "encodeBody": "manual",
    "headers": original.headers,
    "status": original.status,
    "statusText": original.statusText
  }
  const response = new Response(readable, init);
  for (const header of headers) {
    response.headers.append(header[0], header[1]);
  }
  if (zstd !== null) {
    response.headers.set("Content-Encoding", 'dcz',);
    ctx.waitUntil(compressStreamZstd(original, writable, dictionary, host, origin));
  }
  return response;
}

async function compressStreamZstd(original, writable, dictionary, host, origin) {
  const reader = original.body.getReader();
  const writer = writable.getWriter();
  const contentType = original.headers.get("content-type");

  // allocate a compression context and buffers before the stream starts
  let cctx = null;
  let inBuff = null;
  let outBuff = null;
  try {
    cctx = zstd.createCCtx();
    inBuff = getBuffer();
    outBuff = getBuffer();
  if (cctx !== null) {
      // configure the zstd parameters
      zstd.CCtx_setParameter(cctx, zstd.cParameter.c_compressionLevel, compressionLevel);
      zstd.CCtx_setParameter(cctx, zstd.cParameter.c_windowLog, compressionWindowLog );
      zstd.CCtx_refCDict(cctx, dictionary.dictionary);
    }
  } catch (E) {
    console.log(E);
  }

  let isFirstChunk = true;
  let chunksGathered = 0;
  let headerWritten = false;

  // streaming compression modeled after https://github.com/facebook/zstd/blob/dev/examples/streaming_compression.c
  while (true) {
    let { value, done } = await reader.read();

    // rewrite the URLs for HTML content
    if (!done && contentType && contentType.indexOf("text/html") !== -1) {
      let html = new TextDecoder().decode(value);
      html = html.replaceAll(origin, host);
      // Make sure not to rewrite the canonical URL for the page
      html = html.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://' + origin);
      html = html.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://' + origin);
      value = new TextEncoder().encode(html);
    }
    const size = done ? 0 : value.byteLength;
    
    // Grab chunks of the input stream in case it is bigger than the zstd buffer
    let pos = 0;
    const inBuffer = new zstd.inBuffer();
    const outBuffer = new zstd.outBuffer();
    while (pos < size || done) {
      const endPos = Math.min(pos + bufferSize, size);
      const chunkSize = done ? 0 : endPos - pos;
      const chunk = done ? null : value.subarray(pos, endPos);
      pos = endPos;

      try {
        if (chunkSize > 0) {
          wasm.HEAPU8.set(chunk, inBuff);
        }

        inBuffer.src = inBuff;
        inBuffer.size = chunkSize;
        inBuffer.pos = 0;
        let finished = false;
        do {
          outBuffer.dst = outBuff;
          outBuffer.size = bufferSize;
          outBuffer.pos = 0;

          // Use a naive flushing strategy for now. Flush the first chunk immediately and then let zstd decide
          // when each chunk should be emitted (likey accumulate until complete).
          // Also, every 5 chunks that were gathered, flush irregardless.
          let mode = zstd.EndDirective.e_continue;
          if (done) {
            mode = zstd.EndDirective.e_end;
          } else if (isFirstChunk || chunksGathered >= 4) {
            mode = zstd.EndDirective.e_flush;
            isFirstChunk = false;
            chunksGathered = 0;
          }

          const remaining = zstd.compressStream2(cctx, outBuffer, inBuffer, mode);

          // Keep track of the number of chunks processed where we didn't send any response.
          if (outBuffer.pos == 0) chunksGathered++;

          if (outBuffer.pos > 0) {
            if (!headerWritten) {
              const dczHeader = new Uint8Array([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00, ...dictionary.hash]);
              await writer.write(dczHeader);
              headerWritten = true;
            }
            const data = new Uint8Array(wasm.HEAPU8.buffer, outBuff, outBuffer.pos);
            await writer.write(data.slice(0));  // Write a copy of the buffer so it doesn't get overwritten
          }

          finished = done ? (remaining == 0) : (inBuffer.pos == inBuffer.size);
        } while (!finished);
      } catch (E) {
        console.log(E);
      }
      if (done) break;
    }
    if (done) break;
  }

  // Free the zstd context and buffers
  releaseBuffer(inBuff);
  releaseBuffer(outBuff);
  if (cctx !== null) zstd.freeCCtx(cctx);

  await writer.close();
  await cleanup();
}

/*
 Handle the client request for a dictionary
*/
async function fetchDictionary(env, request) {
  const url = new URL(request.url);
  const id = url.pathname.slice(dictionaryPath.length).replace(/\/+$/, "").replace(/^\/+/, "");
  if (id in SITES) {
    const info = SITES[id];
    const expires = 30 * 24 * 60 * 60;
    const assetUrl = new URL(info.dictionary, url);
    const response = await env.ASSETS.fetch(assetUrl);
    return new Response(response.body, {
      headers: {
        "content-type": "text/plain; charset=UTF-8",  /* Can be anything but text/plain will allow for Cloudflare to apply compression */
        "cache-control": "public, max-age=" + expires,
        "use-as-dictionary": 'id="' + id + '", match="/*", match-dest=("document" "frame")'
      }
    });
  } else {
    console.log("Matching dictionary not found");
    return await fetch(request);
  }
}


/*
  Initialize wasm and load the matching dictionary in parallel
*/
async function loadDictionary(request, env, ctx) {
  let dictionary = null;
  const availableDictionary = request.headers.get("available-dictionary").trim().replaceAll(':', '')
  const hash = base64ToUint8Array(availableDictionary);
  const id = request.headers.get("dictionary-id").trim().replaceAll('"', '');

  // Initialize wasm
  let loadingWasm = false;
  if (zstd === null) {
    loadingWasm = true;
    zstdInit(ctx).catch(E => console.log(E));
  }

  // Fetch the dictionary if we don't already have it
  if (!(id in dictionaries)) {
    // The ID will be a key from SITES
    let response = null;
    if (id in SITES) {
      const url = new URL(SITES[id].dictionary, request.url);
      response = await env.ASSETS.fetch(url);
    }

    if (response !== null && response.ok) {
      const bytes = await response.bytes();
      if (loadingWasm && wasmLoaded !== null) {
        await wasmLoaded;
        loadingWasm = false;
      }
      // Get the hash of the dictionary and store it in encoder-specific format
      const dictionaryHash = await crypto.subtle.digest({name: 'SHA-256'}, bytes);
      const raw = prepareDictionary(bytes);
      dictionaries[id] = {
        "hash": new Uint8Array(dictionaryHash),
        "dictionary": raw
      };
    }
  }

  // wait for wasm to finish
  if (loadingWasm && wasmLoaded !== null) {
    await wasmLoaded;
  }
  
  let supportsDCZ = false;
  if ("cf" in request && "clientAcceptEncoding" in request.cf) {
    supportsDCZ = request.cf.clientAcceptEncoding.indexOf("dcz") !== -1 && zstd !== null;
  }
  if (supportsDCZ && id in dictionaries && "hash" in dictionaries[id] && areUint8ArraysEqual(dictionaries[id]["hash"], hash)) {
    dictionaries[id]['lastUsed'] = performance.now();
    dictionary = dictionaries[id];
  } else {
    console.log("Dictionary mismatch");
    if (!supportsDCZ) console.log("Does not support dcz");
    if (!(id in dictionaries)) {
      console,log("Dictionary " + id + " not found")
    } else if (!areUint8ArraysEqual(dictionaries[id]["hash"], hash)) {
      console.log("Hash mismatch");
      console.log(dictionaries[id].hash);
      console.log(hash);
    }
  }

  return dictionary;
}

// wasm setup
async function zstdInit(ctx) {
  if (zstd === null && wasmLoaded === null && (typeof zstdlib !== 'undefined')) {
    let resolve;
    wasmLoaded = new Promise((res, rej) => {
      resolve = res;
    });
    // Keep the request alive until wasm loads
    ctx.waitUntil(wasmLoaded);
    zstd = await zstdlib({
      instantiateWasm(info, receive) {
        let instance = new WebAssembly.Instance(zstdwasm, info);
        receive(instance);
        return instance.exports;
      },
      locateFile(path, scriptDirectory) {
        return path
      },
    }).catch(E => console.log(E));
    wasm = zstd;
    resolve(true);
  }
}

function prepareDictionary(bytes) {
  let prepared = null;
  try {
    if (bytes !== null) {
      const d = wasm._malloc(bytes.byteLength)
      wasm.HEAPU8.set(bytes, d);
      if (zstd !== null) {
        prepared = zstd.createCDict(d, bytes.byteLength, compressionLevel);
      } else if (brotli !== null) {
        prepared = brotli.PrepareDictionary(brotli.SharedDictionaryType.Raw, bytes.byteLength, d, compressionLevel);
      }
      wasm._free(d);
    }
  } catch (E) {
    console.log(E);
  }
  return prepared;
}

function base64ToUint8Array(base64String) {
  const decodedString = atob(base64String);
  const uint8Array = new Uint8Array(decodedString.length);

  for (let i = 0; i < decodedString.length; i++) {
    uint8Array[i] = decodedString.charCodeAt(i);
  }

  return uint8Array;
}

function areUint8ArraysEqual(arr1, arr2) {
  if (arr1.length !== arr2.length) {
    return false;
  }

  for (let i = 0; i < arr1.length; i++) {
    if (arr1[i] !== arr2[i]) {
      return false;
    }
  }

  return true;
}

function getBuffer() {
  let buffer = buffers.pop();
  if (!buffer && wasm !== null) {
    buffer = wasm._malloc(bufferSize);
  }
  if (!buffer) {
    console.log("Error allocating buffer");
  }
  return buffer
}

function releaseBuffer(buffer) {
  if (buffer !== null) {
    buffers.push(buffer);
  }
}

function toHex(buffer) {
  return Array.prototype.map.call(buffer, x => ('00' + x.toString(16)).slice(-2)).join('');
}

// TODO: Free any buffers that haven't been used in a while
let lastCleanup = null;
const CLEANUP_INTERVAL = 600 * 1000; // Every 5 minutes
const DICTIONARY_TTL = 3600 * 1000;  // Keep unused dictionaries for an hour
async function cleanup() {
  const now = performance.now();
  if (!lastCleanup || now - lastCleanup >= CLEANUP_INTERVAL) {
    try {
      lastCleanup = now;
      const keys = [];
      for (const id in dictionaries) {
        if ("lastUsed" in dictionaries[id] && now - dictionaries[id]["lastUsed"] > DICTIONARY_TTL) {
          keys.push(id);
        }
      }
      for (const key in keys) {
        console.log("Deleting stale dictionary: " + key);
        delete dictionaries[key];
      }
    } catch (E) {
      console.log(E);
    }
  }
}