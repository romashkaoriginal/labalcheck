const left=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const middle=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const right=['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const parity=['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

export function parseEan13(bits){
 if(bits.length!==95||!bits.startsWith('101')||bits.slice(45,50)!=='01010'||!bits.endsWith('101'))return null;
 let digits='',code='';
 for(let i=0;i<6;i++){const chunk=bits.slice(3+i*7,10+i*7),l=left.indexOf(chunk),g=middle.indexOf(chunk);if(l>=0){digits+=l;code+='L';}else if(g>=0){digits+=g;code+='G';}else return null;}
 const first=parity.indexOf(code);if(first<0)return null;
 let value=String(first)+digits;
 for(let i=0;i<6;i++){const digit=right.indexOf(bits.slice(50+i*7,57+i*7));if(digit<0)return null;value+=digit;}
 const checksum=Number(value.slice(0,12).split('').reduce((sum,d,i)=>sum+Number(d)*(i%2?3:1),0));
 return (10-checksum%10)%10===Number(value[12])?value:null;
}

export function scanEan13({data,width,height},wanted=null){
 const ink=(x,y)=>{const i=(y*width+x)*4;return (data[i]*.299+data[i+1]*.587+data[i+2]*.114)<125;};
 let first=null;
 for(const vertical of [false,true]){
  const length=vertical?height:width,rows=vertical?width:height;
  for(let line=3;line<rows-3;line+=Math.max(3,Math.floor(rows/110))){
   const pixels=Array.from({length},(_,i)=>vertical?ink(line,i):ink(i,line));
   for(const reverse of [false,true]){
    const p=reverse?pixels.toReversed():pixels;
    let previous=0;
    for(let x=1;x<length-96;x++){
     if(!p[x]||p[x-1])continue;
     let end=x+1;while(end<length&&p[end])end++;
     const base=end-x;
     if(base<1||base>Math.max(14,length/95*2))continue;
     let quiet=true;for(let i=Math.max(0,x-base*6);i<x;i++)if(p[i]){quiet=false;break;}if(!quiet)continue;
     // Rasterization can make a one-module guard bar narrower than the mean
     // module. Estimate the complete 59-run symbol before sampling its bits.
     let runEnd=x,runs=0,color=true;
     while(runEnd<length&&runs<59){while(runEnd<length&&p[runEnd]===color)runEnd++;runs++;color=!color;}
     const modules=[...(runs===59?[(runEnd-x)/95]:[]),...[.85,.9,.95,1,1.01,1.0125,1.02,1.05,1.1,1.15,1.17,1.2,1.21,1.215,1.22,1.23,1.25].map(factor=>base*factor)];
     for(const module of modules){
      if(x+95*module>=length)continue;
      for(const shift of [-.5,-.4,-.3,-.2,-.1,0,.1,.2]){
       const bits=Array.from({length:95},(_,i)=>p[Math.round(x+(i+.5+shift)*module)]?'1':'0').join('');
       const text=parseEan13(bits);if(!text)continue;
       const span=95*module,position=reverse?length-x-span:x,guard=Math.max(0,Math.min(length-1,Math.round(position+module*.5)));
       let crossStart=line,crossEnd=line;
       while(crossStart>0&&(vertical?ink(crossStart-1,guard):ink(guard,crossStart-1)))crossStart--;
       while(crossEnd<rows-1&&(vertical?ink(crossEnd+1,guard):ink(guard,crossEnd+1)))crossEnd++;
       const box=vertical?{x:crossStart/width,y:position/height,w:(crossEnd-crossStart+1)/width,h:span/height}:{x:position/width,y:crossStart/height,w:span/width,h:(crossEnd-crossStart+1)/height};
       const found={text,box};if(!first)first=found;if(!wanted||wanted===text)return found;
      }
     }
     x=end-1;
    }
   }
  }
 }
 return first;
}
