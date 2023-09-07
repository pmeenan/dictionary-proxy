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
    let response = await(fetch(url.toString(), request));
    let body = response.body;

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.indexOf("text/html") !== -1) {
      body = await response.text();
      body = body.replaceAll("www.etsy.com", host);
      // Make sure not to rewrite the canonical URL for the page
      body = body.replaceAll('<link rel="canonical" href="https://' + host, '<link rel="canonical" href="https://www.etsy.com');
      body = body.replaceAll('<link rel="alternate" href="https://' + host, '<link rel="alternate" href="https://www.etsy.com');
    }

    // generate the actual response
    response = new Response(body, response);

    // Add the origin trial token and dictionary response headers
    const token = "Amw+JMEMwDP5iwX7N4RS2e2DZ4PcuJfi3co/P1MoP5l+9veIs1KQATkJ0a+HjkMrQnQAOT/fZW2S7FekTd2KJgsAAABueyJvcmlnaW4iOiJodHRwczovL2V0c3kucGF0cmlja21lZW5hbi5jb206NDQzIiwiZmVhdHVyZSI6IkNvbXByZXNzaW9uRGljdGlvbmFyeVRyYW5zcG9ydCIsImV4cGlyeSI6MTcxNDUyMTU5OX0=";
    response.headers.append("Origin-Trial", token);

    return response;
  } else {
    // Just proxy the request
    return fetch(url.toString(), request)
  }
}
