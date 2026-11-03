module.exports = (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.status(405).json({error:'method not allowed'});return;}
  res.status(200).json({release:'stock-v1',commit:process.env.SF_RELEASE_COMMIT||process.env.VERCEL_GIT_COMMIT_SHA||'local',
    nutritionEnabled:false,aiEnabled:process.env.SF_ENABLE_AI_CHAT==='1',
    notificationsEnabled:process.env.SF_ENABLE_NOTIFICATIONS==='1',automationsEnabled:process.env.SF_ENABLE_AUTOMATIONS==='1'});
};
