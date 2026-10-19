import { resolve } from 'node:path';
import { createApp } from './app.mjs';
const app=createApp({dataDir:resolve(process.env.DATA_DIR||'data')});
const port=Number(process.env.PORT||3001);
const server=app.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`Threadwork listening on :${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close(()=>process.exit(0));app.locals.shutdown();});
