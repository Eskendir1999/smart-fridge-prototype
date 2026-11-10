module.exports = (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.status(405).json({error:'method not allowed'});return;}
  res.status(200).json({release:'my-data-stage3',commit:process.env.SF_RELEASE_COMMIT||process.env.VERCEL_GIT_COMMIT_SHA||'local',
    nutritionEnabled:false,aiEnabled:false,pilotMetricsEnabled:false,personalDataEnabled:true,dinnerEnabled:process.env.SF_ENABLE_DINNER==='1',deletionReceiptDays:90,
    telegramOnDemandEnabled:process.env.SF_ENABLE_TELEGRAM==='1',notificationsEnabled:process.env.SF_ENABLE_NOTIFICATIONS==='1',automationsEnabled:false});
};
