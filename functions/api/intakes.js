export async function onRequestGet({ env }) {
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
            sql: 'SELECT ID, item, brand, daily_qty, "from", payment_structure, listing_id, Price FROM intakes ORDER BY item ASC',
          },
        },
        { type: "close" },
      ],
    }),
  });

  if (!res.ok) {
    return Response.json({ error: "Database error" }, { status: 502 });
  }

  const data = await res.json();
  const result = data.results[0].response.result;
  const cols = result.cols.map((c) => c.name);
  const rows = result.rows.map((row) =>
    Object.fromEntries(cols.map((col, i) => [col, row[i].value ?? null]))
  );

  return Response.json(rows, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
