function httpUrl(env) {
  return env.TURSO_URL.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
}

export async function onRequestGet({ env }) {
  const res = await fetch(`${httpUrl(env)}/v2/pipeline`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.TURSO_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requests: [
        { type: "execute", stmt: { sql: "SELECT Name FROM Suppliers ORDER BY Name" } },
        { type: "close" },
      ],
    }),
  });

  if (!res.ok) return Response.json({ error: "Database error" }, { status: 502 });

  const data = await res.json();
  const result = data.results[0].response.result;
  const names = result.rows.map((row) => row[0].value);

  return Response.json(names, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
