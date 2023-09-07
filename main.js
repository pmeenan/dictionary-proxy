addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const host = url.hostname;
  url.hostname = 'www.etsy.com';

  const dest = request.headers.get("sec-fetch-dest");

  if (dest && dest.indexOf("document") !== -1) {
    // Rewrite document HTML requests
    const originalResponse = await(fetch(url.toString(), request));
    const contentType = originalResponse.headers.get("content-type");
    if (contentType && contentType.indexOf("text/html") !== -1) {
      let clonedResponse = originalResponse.clone();
      let body = await clonedResponse.text();
      body = body.replaceAll("www.etsy.com", host);
      // Make sure not to rewrite the canonical URL for the page
      body = body.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://www.etsy.com');
      body = body.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://www.etsy.com');

      let response = new Response(body, clonedResponse);
      return response;
    } else {
      return originalResponse;
    }
  } else {
    // Just proxy the request
    return fetch(url.toString(), request)
  }
}
