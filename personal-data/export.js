(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SFDataExport=api;})(globalThis,function(){
 'use strict';
 function cell(value){
  const raw=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  // CSV quoting alone does not prevent spreadsheet formula injection.
  const safe=/^[\s\u0000-\u001f]*[=+\-@]/.test(raw)||/^[\t\r\n]/.test(raw)?"'"+raw:raw;
  return '"'+safe.replaceAll('"','""')+'"';
 }
 function csv(snapshot){
  const rows=[['section','record_id','profile_id','field','value']];
  for(const section of ['profiles','measurements','legacy_measurements','legacy_messages','legacy_summaries']){
   for(const record of snapshot[section]||[])for(const [field,value] of Object.entries(record))rows.push([section,record.id,record.profile_id||'',field,value]);
  }
  rows.push(['metadata','','','exported_at',snapshot.exported_at],['metadata','','','ai',snapshot.ai],['metadata','','','legacy_scope',snapshot.legacy_scope],['metadata','','','deletion_limits',snapshot.deletion_limits]);
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
 }
 return {csv};
});
