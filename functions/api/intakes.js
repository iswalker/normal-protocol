export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    "SELECT id, item, brand, daily_qty, source, payment, listing_id FROM intakes ORDER BY item ASC"
  ).all();

  return Response.json(results, {
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}
