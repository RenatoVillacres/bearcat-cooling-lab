import {calculateRun} from './engine.mjs';
self.onmessage=({data})=>{
  try {
    const r=calculateRun(data.rows,data.config);
    const {windows,segments,...result}=r;
    result.segments=segments.map(({points,cumulative,...summary})=>summary);
    self.postMessage({id:data.id,result});
  }catch(e){self.postMessage({id:data.id,error:e.message});}
};
