// Downloads the ONNX models of the local method from PaddlePaddle's own model
// host and unpacks inference.onnx + inference.yml into desktop/models/<name>/.
// Every archive is pinned by SHA-256: a changed file upstream stops the run
// instead of silently changing what the experiment measures.
//   node scripts/fetch-models.mjs            download what is missing
//   node scripts/fetch-models.mjs --print    print the hashes of what is there
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),models=path.join(root,'models');
const host='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
const manifest=JSON.parse(readFileSync(path.join(models,'manifest.json'),'utf8'));

// The two models of the web version are already in the repository.
const local=name=>path.resolve(root,'../assets/models',name+'_onnx_infer.tar');

function untar(bytes){
 const files={};
 for(let at=0;at+512<=bytes.length;){
  const name=bytes.subarray(at,at+100).toString('utf8').replace(/\0.*$/s,''),size=parseInt(bytes.subarray(at+124,at+136).toString('utf8').replace(/\0.*$/s,'').trim()||'0',8),type=String.fromCharCode(bytes[at+156]||48);
  if(!name)break;
  if(type==='0'||type==='\0')files[name]=bytes.subarray(at+512,at+512+size);
  at+=512+Math.ceil(size/512)*512;
 }
 return files;
}

for(const model of manifest.models){
 const dir=path.join(models,model.name),onnx=path.join(dir,'inference.onnx');
 if(process.argv.includes('--print')){if(existsSync(onnx))console.log(model.name,createHash('sha256').update(readFileSync(onnx)).digest('hex'));continue;}
 if(existsSync(onnx)&&existsSync(path.join(dir,'inference.yml'))){console.log('ok      ',model.name);continue;}
 let bytes;
 if(existsSync(local(model.name))){bytes=readFileSync(local(model.name));console.log('repo    ',model.name);}
 else{
  const url=host+model.name+'_onnx_infer.tar';console.log('download',model.name,`(${model.megabytes} MB)`);
  const response=await fetch(url);if(!response.ok)throw new Error(`${url}: HTTP ${response.status}`);
  bytes=Buffer.from(await response.arrayBuffer());
 }
 const sha=createHash('sha256').update(bytes).digest('hex');
 if(model.sha256&&model.sha256!==sha)throw new Error(`${model.name}: archive hash ${sha} differs from the pinned ${model.sha256}`);
 if(!model.sha256)console.log('  sha256',sha,'(not pinned yet: add it to models/manifest.json)');
 const files=untar(bytes),pick=suffix=>Object.entries(files).find(([name])=>name.endsWith('/'+suffix)&&!name.includes('.cache'))?.[1];
 const model_=pick('inference.onnx'),config=pick('inference.yml');
 if(!model_||!config)throw new Error(`${model.name}: archive holds no inference.onnx / inference.yml`);
 mkdirSync(dir,{recursive:true});writeFileSync(onnx,model_);writeFileSync(path.join(dir,'inference.yml'),config);
}
