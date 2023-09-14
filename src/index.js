import zstdlib from "../zstd-wasm-compress/bin/zstdlib.js";
import zstdwasm from "../zstd-wasm-compress/bin/zstdlib.wasm";

let zstd = null;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;
    url.hostname = 'www.etsy.com';

    const dest = request.headers.get("sec-fetch-dest");

    if (dest && dest.indexOf("document") !== -1) {
      // Rewrite document HTML requests
      let response = await(fetch(url.toString(), request));
      let body = response.body;
      let encoding = null;
      let ver = null;

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.indexOf("text/html") !== -1) {
        body = await response.text();
        body = body.replaceAll("www.etsy.com", host);
        // Make sure not to rewrite the canonical URL for the page
        body = body.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://www.etsy.com');
        body = body.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://www.etsy.com');

        // we send our own instantiateWasm function
        // to the zstdlib module
        // so we can initialize the WASM instance ourselves
        // since Workers puts your wasm file in global scope
        // as a binding. In this case, this binding is called
        // `wasm` as that is the name Wrangler uses
        // for any uploaded wasm module
        if (!zstd) {
          zstd = await zstdlib({
            instantiateWasm(info, receive) {
              console.log("instantiateWasm");
              let instance = new WebAssembly.Instance(zstdwasm, info);
              receive(instance);
              return instance.exports;
            },
            locateFile(path, scriptDirectory) {
              // scriptDirectory is undefined, so this is a
              // no-op to avoid exception "TypeError: Invalid URL string."
              console.log("locateFile");
              return path
            },
          });
        }

        // See if dictionary compression was requested (TODO)
        ver = zstd.versionNumber()

        /*
        // Try ZStandard if it was advertised
        if (request.cf.clientAcceptEncoding.indexOf("zstd")) {
          body = compress(body, 10);
          encoding = zstd;
        }
        */
      }

      // generate the actual response
      response = new Response(body, response);

      if (encoding) {
        response.encodeBody = "manual";
        response.headers.set("Content-Encoding", encoding);
      }

      if (ver) {
        response.headers.set("X-Zstd-Version", ver);
      }

      // Add the origin trial token and dictionary response headers
      const token = "Amw+JMEMwDP5iwX7N4RS2e2DZ4PcuJfi3co/P1MoP5l+9veIs1KQATkJ0a+HjkMrQnQAOT/fZW2S7FekTd2KJgsAAABueyJvcmlnaW4iOiJodHRwczovL2V0c3kucGF0cmlja21lZW5hbi5jb206NDQzIiwiZmVhdHVyZSI6IkNvbXByZXNzaW9uRGljdGlvbmFyeVRyYW5zcG9ydCIsImV4cGlyeSI6MTcxNDUyMTU5OX0=";
      response.headers.append("Origin-Trial", token);

      return response;
    } else {
      // Just proxy the request
      return fetch(url.toString(), request)
    }
  }
}
