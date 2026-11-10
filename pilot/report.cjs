#!/usr/bin/env node
'use strict';
// Offline CLI. Defaults to unverified evidence; never accepts a URL or connects to a service.
const fs=require('node:fs');
const {summarize}=require('./analytics.cjs');
if(process.argv.length!==3){console.error('Usage: node pilot/report.cjs /path/to/approved-export.json');process.exitCode=2;}
else try{
 const file=process.argv[2];if(/^\w+:\/\//.test(file))throw Error('local file required');
 if(fs.statSync(file).size>10*1024*1024)throw Error('input exceeds 10 MiB');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 console.log(JSON.stringify(summarize(data.events,data.config),null,2));
}catch(e){console.error('Report rejected: '+e.message);process.exitCode=1;}
