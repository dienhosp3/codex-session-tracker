'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),files=[path.join(root,'README.md'),path.join(root,'AGENTS.md')];
function walk(directory){for(const item of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())walk(file);else if(item.name.endsWith('.md'))files.push(file);}}
walk(path.join(root,'docs'));
const broken=[];let links=0;
for(const file of files){
 const source=fs.readFileSync(file,'utf8');
 for(const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
  const target=match[1].replace(/^<|>$/g,'').split('#')[0];
  if(!target||/^[a-z]+:/i.test(target))continue;
  links++;
  if(!fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(target))))broken.push(path.relative(root,file)+': '+target);
 }
}
if(broken.length){console.error(broken.join('\n'));process.exitCode=1;}
else console.log(JSON.stringify({documents:files.length,localLinks:links,broken:0}));
