import test from 'node:test';
import assert from 'node:assert/strict';
import {parseEan13,scanEan13} from '../src/barcode.js';

const printed='10101101110110011011110101101110111001001101101010111001011100101010000110110010100001110100101';
test('reads a valid EAN-13 and rejects changed check digit',()=>{assert.equal(parseEan13(printed),'4813852006269');assert.equal(parseEan13(printed.slice(0,50)+'0000000'+printed.slice(57)),null);});
test('locates barcode at an arbitrary page position',()=>{
 const width=850,height=160,data=new Uint8ClampedArray(width*height*4).fill(255);
 for(let y=64;y<125;y++)for(let m=0;m<95;m++)if(printed[m]==='1')for(let x=130+m*5;x<130+(m+1)*5;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 const found=scanEan13({data,width,height});assert.equal(found?.text,'4813852006269');assert.ok(found.box.x>.1&&found.box.x<.2);
});
test('small rasterized barcode uses its complete span instead of a rounded guard width',()=>{
 const width=340,height=100,data=new Uint8ClampedArray(width*height*4).fill(255),start=31,module=2.63;
 for(let y=20;y<80;y++)for(let x=start;x<start+95*module;x++)if(printed[Math.floor((x-start)/module)]==='1'){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
 assert.equal(scanEan13({data,width,height})?.text,'4813852006269');
});
