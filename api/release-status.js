module.exports = (req, res) => {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.status(405).json({error:'method not allowed'});return;}
  res.status(200).json({release:'my-data-stage3',commit:process.env.SF_RELEASE_COMMIT||process.env.VERCEL_GIT_COMMIT_SHA||'local',
    nutritionEnabled:false,aiEnabled:false,personalDataEnabled:true,deletionReceiptDays:90,
    notificationsEnabled:process.env.SF_ENABLE_NOTIFICATIONS==='1',automationsEnabled:false});
};
