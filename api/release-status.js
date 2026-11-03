module.exports = (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.status(405).json({error:'method not allowed'});return;}
  res.status(200).json({release:'nutrition-stage2-safe',commit:process.env.SF_RELEASE_COMMIT||process.env.VERCEL_GIT_COMMIT_SHA||'local',
    nutritionEnabled:false,dinnerEnabled:process.env.SF_ENABLE_DINNER==='1',aiEnabled:false,
    notificationsEnabled:process.env.SF_ENABLE_NOTIFICATIONS==='1',automationsEnabled:false});
};
