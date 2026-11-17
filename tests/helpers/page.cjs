// Browser tests replace CDN scripts with local stubs; production SRI would (correctly) block them.
// Only the test server strips integrity attributes; the shipped page keeps them.
const stripIntegrity=html=>String(html).replace(/ integrity="[^"]*"/g,'');
module.exports={stripIntegrity};
