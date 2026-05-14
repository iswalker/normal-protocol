export async function onRequestPatch({ params, request, env }) {
  const id = parseInt(params.id, 10);
  if (!id) return Response.json({ error: "Invalid ID" }, { status: 400 });

  const body = await request.json();
  const { from: supplier } = body;
  if (typeof supplier !== "string") {
    return Response.json({ error: "Missing field: from" }, { status: 400 });
  }

  const res = await fetch(`${env.TURSO_URL}/v2/pipeline`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: {
            sql: 'UPDATE intakes SET "from" = ? WHERE ID = ?',
            args: [
              { type: "text", value: supplier },
              { type: "integer", value: String(id) },
            ],
          },
        },
        { type: "close" },
      ],
    }),
  });

  if (!res.ok) return Response.json({ error: "Database error" }, { status: 502 });

  const data = await res.json();
  const result = data.results[0];
  if (result.type !== "ok") {
    return Response.json({ error: "Update failed" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
