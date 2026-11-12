import type { SupabaseClient } from '@supabase/supabase-js';
type RpcResult<T>={data:T|null;error:{message:string;code?:string}|null};

async function userCall<T>(client:SupabaseClient,name:string,args:Record<string,unknown>,kind:'rpc'|'admin/rpc'):Promise<RpcResult<T>>{
 const base=process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/,'');
 if(!base)return await client.rpc(name,args) as RpcResult<T>;
 const {data:{session},error}=await client.auth.getSession();
 const publicCall=kind==='rpc'&&name==='seller_public_verification'&&!session?.access_token;
 if(!session?.access_token&&!publicCall)return{data:null,error:{message:error?.message||'Session could not be verified.',code:'UNAUTHORIZED'}};
 try{
  const response=await fetch(`${base}/v1/${publicCall?'public/rpc':kind}/${encodeURIComponent(name)}`,{
   method:'POST',headers:{...(session?.access_token?{Authorization:`Bearer ${session.access_token}`}:{}),'Content-Type':'application/json'},
   body:JSON.stringify(args),cache:'no-store'
  });
  const data=await response.json().catch(()=>null);
  if(!response.ok)return{data:null,error:{message:typeof data?.error==='string'?data.error:'Operation failed.',code:String(response.status)}};
  return{data:data as T,error:null};
 }catch{return{data:null,error:{message:'Rust API is temporarily unavailable.',code:'API_UNAVAILABLE'}}}
}
export const callRustRpc=<T=unknown>(client:SupabaseClient,name:string,args:Record<string,unknown>={})=>userCall<T>(client,name,args,'rpc');
export const callRustAdminRpc=<T=unknown>(client:SupabaseClient,name:string,args:Record<string,unknown>={})=>userCall<T>(client,name,args,'admin/rpc');

export async function callRustInternalRpc<T=unknown>(name:string,args:Record<string,unknown>={}){
 const base=process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/,'');const secret=process.env.RUST_INTERNAL_SECRET;
 if(!base||!secret)return{data:null as T|null,error:{message:'Internal Rust service is not configured.'}};
 try{const r=await fetch(`${base}/v1/internal/rpc/${encodeURIComponent(name)}`,{method:'POST',headers:{'x-internal-secret':secret,'Content-Type':'application/json'},body:JSON.stringify(args),cache:'no-store'});const data=await r.json().catch(()=>null);return r.ok?{data:data as T,error:null}:{data:null,error:{message:data?.error||'Internal operation failed.',code:String(r.status)}}}
 catch{return{data:null,error:{message:'Rust API is temporarily unavailable.'}}}
}
export async function callRustJob<T=unknown>(name:string,secret:string){
 const base=process.env.RUST_BACKEND_URL?.trim().replace(/\/+$/,'');
 if(!base||!secret)return{data:null as T|null,error:{message:'Internal Rust service is not configured.'}};
 try{const r=await fetch(`${base}/v1/internal/jobs/${encodeURIComponent(name)}`,{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});const data=await r.json().catch(()=>null);return r.ok?{data:data as T,error:null}:{data:null,error:{message:data?.error||'Scheduled task failed.',code:String(r.status)}}}
 catch{return{data:null,error:{message:'Rust API is temporarily unavailable.'}}}
}
