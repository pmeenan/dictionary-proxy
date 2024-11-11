# dictionary-proxy
This is a Cloudflare worker used for experimenting with [compression dictionaries](https://datatracker.ietf.org/doc/draft-ietf-httpbis-compression-dictionary/) on arbitrary sites. It does this by proxying the original site through the worker, rewriting all of the URLs in HTML content to point to the experiment domain. The worker uses a wasm build of ZStandard to apply the compression dynamically.

It is (currently) expecting to use one dictionary per test domain and only apply compression to the HTML responses and is not targeted at experimenting with delta-compression of the static assets (though that could easily be added based on [dictionary-worker](https://github.com/pmeenan/dictionary-worker)).

To add a new domain for testing:
* Add a new SITES entry to [src/index.js](src/index.js) without a dictionary specified. i.e. `"cnn.patrickmeenan.com": {"origin": "www.cnn.com"}`.
* Add a new route to [wrangler.toml](wrangler.toml) for the test domain using the same key as above. i.e. `{pattern = "cnn.patrickmeenan.com", custom_domain = true}`.
* Publish the worker.
* Test the proxy to make sure the site behaves reasonably well when proxied.
* Generate a dictionary for a representative set of pages on the test origin using the hosted [dictionary generator](https://use-as-dictionary.com/generate/).
* Save the generated dictionary to the [/assets](assets/) folder. i.e. `cnn.dat`
* Update the SITES entry in [src/index.js](src/index.js) to reference the dictionary. i.e. `"cnn.patrickmeenan.com": {"dictionary": "/cnn.dat", "origin": "www.cnn.com"},`.
* Publish the worker.

You should now be able to browse the test page and have the HTML compressed using the generated dictionary.