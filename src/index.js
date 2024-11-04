import zstdlib from "../zstd-wasm-compress/bin/zstdlib.js";
import zstdwasm from "../zstd-wasm-compress/bin/zstdlib.wasm";

const currentDictionary = "CBT6TUJsGZiH0-cJQ6IKATQ2UwXJ7NSAVebgLuZXjMU";
const dictionaryPath = "/dictionary/";

// Dictionary options
const match = 'match="/*", match-dest=("document" "frame")'; // Match pattern for the URLs to be compressed
const dictionaryExpiration = 30 * 24 * 3600;                 // 30 day expiration on the dictionary itself

// Compression options
const blocking = true;   // Block requests until wasm and the dictionary have loaded
const compressionLevel = 10;
const compressionWindowLog = 22;  // Compression window should be at least as long as the dictionary + typical response - 2 ^ 22 = 4MB


// Keep a global instance of the zstd wasm to use across requests
// Internal globals for managing state while waiting for the dictionary and zstd wasm to load
let zstd = null;
let dictionaryLoaded = null;
let zstdLoaded = null;
let initialized = false;
let dictionary = null;
let dictionarySize = 0;
let dictionaryJS = null;
const currentHash = atob(currentDictionary.replaceAll('-', '+').replaceAll('_', '/'));
const dictionaryPathname = dictionaryPath + currentDictionary + '.dat';
const dczHeader = new Uint8Array([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00, ...Uint8Array.from(currentHash, c => c.charCodeAt(0))]);

const robots = `User-agent: *
Disallow: /
`;

export default {
  async fetch(request, env, ctx) {
    // Trigger the async dictionary load (has to be done in a request context to have access to env)
    dictionaryInit(request, env, ctx).catch(E => console.log(E));;
    zstdInit(ctx).catch(E => console.log(E));

    const url = new URL(request.url);
    const host = url.hostname;
    url.hostname = 'www.etsy.com';

    const dest = request.headers.get("sec-fetch-dest");

    // Handle the request for the dictionary itself
    const isDictionary = url.pathname == dictionaryPathname;
    if (isDictionary) {
      return await fetchDictionary(env, url);
    } else if (url.pathname == '/robots.txt') {
      return new Response(robots, {headers: {"content-type": "text/plain"}});
    } else if (dest && (dest.indexOf("document") !== -1 || dest.indexOf("frame") !== -1)) {
      const original = await fetch(url.toString(), request);

      // block on the dictionary/zstd init if necessary
      if (blocking) {
        if (zstd === null) { await zstdLoaded; }
        if (dictionary === null) { await dictionaryLoaded; }
      }

      if (original.ok) {
        if (supportsCompression(request) && zstd !== null && dictionary !== null) {
          return await compressResponse(original, ctx, host);
        } else {
          const response = new Response(original.body, original);
          response.headers.append("Link", '<' + dictionaryPathname + '>; rel="compression-dictionary"',);
          return response;
        }
      } else {
        const response = new Response(original.body, original);
        let location = response.headers.get("location");
        if (location) {
          location = location.replaceAll("www.etsy.com", host);
          response.headers.set("location", location);
        }
        return response;
      }
    } else {
      // Just proxy the request
      return fetch(url.toString(), request)
    }
  }
}

/*
  Dictionary-compress the response
*/
async function compressResponse(original, ctx, host) {
  const { readable, writable } = new TransformStream();
  const contentType = original.headers.get("content-type");
  ctx.waitUntil(compressStream(original.body, writable, contentType, host));

  // Add the appropriate headers
  const response = new Response(readable, original);
  let location = response.headers.get("location");
  if (location) {
    location = location.replaceAll("www.etsy.com", host);
    response.headers.set("location", location);
  }
  response.headers.set("Vary", 'Accept-Encoding, Available-Dictionary',);
  response.headers.set("Content-Encoding", 'dcz',);
  response.encodeBody = "manual";
  return response;
}

async function compressStream(readable, writable, contentType, host) {
  const reader = readable.getReader();
  const writer = writable.getWriter();

  // allocate a compression context and buffers before the stream starts
  let cctx = null;
  let zstdInBuff = null;
  let zstdOutBuff = null;
  let inSize = 0;
  let outSize = 0;
  try {
    cctx = zstd.createCCtx();
    if (cctx !== null) {
      inSize = zstd.CStreamInSize();
      outSize = zstd.CStreamOutSize();
      zstdInBuff = zstd._malloc(inSize);
      zstdOutBuff = zstd._malloc(outSize);

      // configure the zstd parameters
      zstd.CCtx_setParameter(cctx, zstd.cParameter.c_compressionLevel, compressionLevel);
      zstd.CCtx_setParameter(cctx, zstd.cParameter.c_windowLog, compressionWindowLog );
      
      zstd.CCtx_refCDict(cctx, dictionary);
    }
  } catch (E) {
    console.log(E);
  }

  // write the dcz header
  await writer.write(dczHeader);
  
  let isFirstChunk = true;
  let chunksGathered = 0;

  // streaming compression modeled after https://github.com/facebook/zstd/blob/dev/examples/streaming_compression.c
  while (true) {
    let { value, done } = await reader.read();

    // rewrite the URLs for HTML content
    if (!done && contentType && contentType.indexOf("text/html") !== -1) {
      let html = new TextDecoder().decode(value);
      html = html.replaceAll("www.etsy.com", host);
      // Make sure not to rewrite the canonical URL for the page
      html = html.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://www.etsy.com');
      html = html.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://www.etsy.com');
      value = new TextEncoder().encode(html);
    }

    // Grab chunks of the input stream in case it is bigger than the zstd buffer
    const size = done ? 0 : value.byteLength;
    let pos = 0;
    while (pos < size || done) {
      const endPos = Math.min(pos + inSize, size);
      const chunkSize = done ? 0 : endPos - pos;
      const chunk = done ? null : value.subarray(pos, endPos);
      pos = endPos;

      try {
        if (chunkSize > 0) {
          zstd.HEAPU8.set(chunk, zstdInBuff);
        }

        const inBuffer = new zstd.inBuffer();
        inBuffer.src = zstdInBuff;
        inBuffer.size = chunkSize;
        inBuffer.pos = 0;
        let finished = false;
        do {
          const outBuffer = new zstd.outBuffer();
          outBuffer.dst = zstdOutBuff;
          outBuffer.size = outSize;
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

          // Keep track of the number of chunks processed where we didn't send any response.
          if (outBuffer.pos == 0) chunksGathered++;

          const remaining = zstd.compressStream2(cctx, outBuffer, inBuffer, mode);

          if (outBuffer.pos > 0) {
            const data = new Uint8Array(zstd.HEAPU8.buffer, outBuffer.dst, outBuffer.pos);
            await writer.write(data);
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

  await writer.close();

  // Free the zstd context and buffers
  if (zstdInBuff !== null) zstd._free(zstdInBuff);
  if (zstdOutBuff !== null) zstd._free(zstdOutBuff);
  if (cctx !== null) zstd.freeCCtx(cctx);
}

/*
 Handle the client request for a dictionary
*/
async function fetchDictionary(env, url) {
  // Just pass the request through to the assets fetch
  url.pathname = '/' + currentDictionary + '.dat';
  let asset = await env.ASSETS.fetch(url);
  return new Response(asset.body, {
    headers: {
      "content-type": "text/plain; charset=UTF-8",  /* Can be anything but text/plain will allow for Cloudflare to apply compression */
      "cache-control": "public, max-age=" + dictionaryExpiration,
      "use-as-dictionary": match
    }
  });
}

/*
 See if the client advertized a matching dictionary and the appropriate encoding
*/
function supportsCompression(request) {
  let hasDictionary = false;
  const availableDictionary = request.headers.get("available-dictionary");
  if (availableDictionary) {
    const availableHash = atob(availableDictionary.trim().replaceAll(':', ''));
    if (availableHash == currentHash) {
      hasDictionary = true;
    }
  }
  const supportsDCZ = request.cf.clientAcceptEncoding.indexOf("dcz") !== -1;
  return hasDictionary && supportsDCZ;
}

/*
  Make sure the dictionary is loaded and cached into the isolate global.
  The current implementation blocks all requests until the dictionary has been loaded.
  This can be modified to fail fast and only use dictionaries after they have loaded.
 */
async function dictionaryInit(request, env, ctx) {
  if (dictionaryJS === null && dictionaryLoaded === null) {
    let resolve;
    dictionaryLoaded = new Promise((res, rej) => {
      resolve = res;
    });
    // Keep the request alive until the dictionary loads
    ctx.waitUntil(dictionaryLoaded);
    const url = new URL(request.url);
    url.pathname = '/' + currentDictionary + '.dat';
    const response = await env.ASSETS.fetch(url);
    if (response.ok) {
      dictionaryJS = await response.bytes();
    }
    postInit();
    resolve(true);
  }
}

// wasm setup
async function zstdInit(ctx) {
  // we send our own instantiateWasm function
  // to the zstdlib module
  // so we can initialize the WASM instance ourselves
  // since Workers puts your wasm file in global scope
  // as a binding. In this case, this binding is called
  // `wasm` as that is the name Wrangler uses
  // for any uploaded wasm module
  if (zstd === null && zstdLoaded === null) {
    let resolve;
    zstdLoaded = new Promise((res, rej) => {
      resolve = res;
    });
    // Keep the request alive until wasm loads
    ctx.waitUntil(zstdLoaded);
    zstd = await zstdlib({
      instantiateWasm(info, receive) {
        let instance = new WebAssembly.Instance(zstdwasm, info);
        receive(instance);
        return instance.exports;
      },
      locateFile(path, scriptDirectory) {
        // scriptDirectory is undefined, so this is a
        // no-op to avoid exception "TypeError: Invalid URL string."
        return path
      },
    }).catch(E => console.log(E));
    postInit();
    resolve(true);
  }
}

// After both the dictionary and wasm have initialized, prepare the dictionary into zstd
// memory so it can be reused efficiently.
function postInit() {
  if (!initialized) {
    if (zstd !== null && dictionaryJS !== null) {
      // copy the dictionary over to wasm
      try {
        let d = zstd._malloc(dictionaryJS.byteLength)
        dictionarySize = dictionaryJS.byteLength;
        zstd.HEAPU8.set(dictionaryJS, d);
        dictionaryJS = null;
        dictionary = zstd.createCDict_byReference(d, dictionarySize, compressionLevel);
        initialized = true;
      } catch (E) {
        console.log(E);
      }
    }
  }
}