// Serverless proxy for Open Food Facts.
// Browsers forbid overriding the User-Agent header from client-side fetch(),
// but Open Food Facts asks API consumers to identify themselves via User-Agent.
// This function makes the request server-side with a proper one.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  const barcode = (req.query.barcode || '').toString().trim();
  if (!/^[0-9]{6,14}$/.test(barcode)) {
    res.status(400).json({ error: 'invalid barcode' });
    return;
  }

  const fields = 'product_name,product_name_ru,brands,image_front_url,image_url,quantity';
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;

  try {
    const offRes = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'SmartFridge/1.0 (personal prototype; contact: mr.taisarinov@gmail.com)',
      },
    });
    if (!offRes.ok) {
      const status = offRes.status === 404 ? 404 : (offRes.status === 429 ? 429 : 502);
      res.status(status).json({ error: 'off_upstream_failed', status: 0 });
      return;
    }
    const data = await offRes.json();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'off_fetch_failed' });
  }
};
