// app/reference/route.ts — serves the Scalar API reference UI at /reference.
//
// Returns a plain HTML Response (Web-standard, framework-version-agnostic). Scalar is loaded from
// CDN and points at the statically-served spec (public/openapi.yaml -> /openapi.yaml). Public:
// the route uses no auth pipeline, so the docs render without a session.

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>arc API Reference</title>
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/openapi.yaml',
        theme: 'default',
        layout: 'modern',
        authentication: { preferredSecurityScheme: 'clerkSession' },
      });
    </script>
  </body>
</html>`;

export function GET(): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
