use crate::AppState;
use axum::{extract::State,http::{header,HeaderMap,StatusCode},response::{IntoResponse,Response},Json};
use serde::Deserialize;
use serde_json::{json,Value};

#[derive(Deserialize)]
pub struct VerifyReference { reference:String }

fn response(status:StatusCode,payload:Value)->Response{(status,Json(payload)).into_response()}
fn fail(status:StatusCode,message:&str)->Response{response(status,json!({"success":false,"error":message}))}

async fn auth_user_id(state:&AppState,headers:&HeaderMap)->Result<String,StatusCode>{
 let token=headers.get(header::AUTHORIZATION).and_then(|v|v.to_str().ok()).and_then(|v|v.strip_prefix("Bearer ")).filter(|v|!v.is_empty()).ok_or(StatusCode::UNAUTHORIZED)?;
 let base=state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let anon=state.settings.supabase_anon_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let r=state.http.get(format!("{}/auth/v1/user",base.trim_end_matches('/'))).header("apikey",anon).bearer_auth(token).send().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 if !r.status().is_success(){return Err(StatusCode::UNAUTHORIZED)}
 let u:Value=r.json().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 u.get("id").and_then(Value::as_str).map(str::to_owned).ok_or(StatusCode::UNAUTHORIZED)
}
async fn profile_id(state:&AppState,auth_id:&str)->Result<i64,StatusCode>{
 let base=state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let key=state.settings.supabase_service_role_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let r=state.http.get(format!("{}/rest/v1/profiles",base.trim_end_matches('/'))).header("apikey",key).bearer_auth(key)
  .query(&[("select","id"),("auth_id",format!("eq.{auth_id}").as_str()),("limit","1")])
  .send().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 if !r.status().is_success(){return Err(StatusCode::BAD_GATEWAY)}
 let rows:Vec<Value>=r.json().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 rows.first().and_then(|x|x.get("id")).and_then(Value::as_i64).ok_or(StatusCode::FORBIDDEN)
}
async fn row_by_reference(state:&AppState,table:&str,select:&str,reference:&str)->Result<Option<Value>,StatusCode>{
 let base=state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let key=state.settings.supabase_service_role_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let r=state.http.get(format!("{}/rest/v1/{table}",base.trim_end_matches('/'))).header("apikey",key).bearer_auth(key)
  .query(&[("select",select),("reference",format!("eq.{reference}").as_str()),("limit","1")])
  .send().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 if !r.status().is_success(){return Err(StatusCode::BAD_GATEWAY)}
 let rows:Vec<Value>=r.json().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 Ok(rows.into_iter().next())
}
async fn verify_paystack(state:&AppState,reference:&str)->Result<Value,StatusCode>{
 let secret=std::env::var("PAYSTACK_SECRET_KEY").ok().filter(|v|!v.trim().is_empty()).ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let escaped=url::form_urlencoded::byte_serialize(reference.as_bytes()).collect::<String>();
 let r=state.http.get(format!("https://api.paystack.co/transaction/verify/{escaped}"))
  .header("Authorization",format!("Bearer {secret}")).send().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 let ok=r.status().is_success();
 let payload:Value=r.json().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 let data=payload.get("data").cloned().unwrap_or(Value::Null);
 if !ok||payload.get("status").and_then(Value::as_bool)!=Some(true)||data.get("status").and_then(Value::as_str)!=Some("success"){return Err(StatusCode::PAYMENT_REQUIRED)}
 if data.get("reference").and_then(Value::as_str)!=Some(reference){return Err(StatusCode::BAD_REQUEST)}
 if !data.get("currency").and_then(Value::as_str).unwrap_or("").eq_ignore_ascii_case("NGN"){return Err(StatusCode::BAD_REQUEST)}
 if data.get("amount").and_then(Value::as_i64).unwrap_or(0)<=0{return Err(StatusCode::BAD_REQUEST)}
 Ok(data)
}
async fn call_service_rpc(state:&AppState,name:&str,args:Value)->Result<Value,StatusCode>{
 let base=state.settings.supabase_url.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let key=state.settings.supabase_service_role_key.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
 let r=state.http.post(format!("{}/rest/v1/rpc/{name}",base.trim_end_matches('/'))).header("apikey",key).bearer_auth(key).json(&args).send().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 let status=r.status();
 let value:Value=r.json().await.map_err(|_|StatusCode::BAD_GATEWAY)?;
 if !status.is_success(){tracing::warn!(rpc=name,status=%status,"Service RPC rejected verification");return Err(StatusCode::BAD_GATEWAY)}
 Ok(value)
}
fn validate_payment(charge:&Value,reference:&str,amount:f64,currency:&str)->Result<(),StatusCode>{
 if charge.get("reference").and_then(Value::as_str)!=Some(reference){return Err(StatusCode::BAD_REQUEST)}
 if charge.get("amount").and_then(Value::as_i64).unwrap_or(0)!=(amount*100.0).round() as i64{return Err(StatusCode::BAD_REQUEST)}
 if !charge.get("currency").and_then(Value::as_str).unwrap_or("").eq_ignore_ascii_case(currency){return Err(StatusCode::BAD_REQUEST)}
 Ok(())
}
async fn wallet_funding(state:&AppState,reference:&str,expected_user:Option<i64>)->Result<Value,StatusCode>{
 let intent=row_by_reference(state,"wallet_funding_intents","id,user_id,reference,amount,currency,status",reference).await?.ok_or(StatusCode::NOT_FOUND)?;
 let id=intent.get("id").and_then(Value::as_i64).ok_or(StatusCode::BAD_GATEWAY)?;
 let user=intent.get("user_id").and_then(Value::as_i64).ok_or(StatusCode::BAD_GATEWAY)?;
 let amount=intent.get("amount").and_then(Value::as_f64).or_else(||intent.get("amount").and_then(Value::as_str).and_then(|v|v.parse().ok())).ok_or(StatusCode::BAD_GATEWAY)?;
 let currency=intent.get("currency").and_then(Value::as_str).unwrap_or("NGN");
 if expected_user.is_some_and(|expected|expected!=user){return Err(StatusCode::NOT_FOUND)}
 if intent.get("status").and_then(Value::as_str)==Some("SUCCESS"){
  return Ok(json!({"success":true,"alreadyCredited":true,"fundingId":id,"reference":reference}))
 }
 if intent.get("status").and_then(Value::as_str)!=Some("PENDING"){return Err(StatusCode::CONFLICT)}
 let charge=verify_paystack(state,reference).await?;
 validate_payment(&charge,reference,amount,currency)?;
 let provider_ref=charge.get("reference").and_then(Value::as_str).unwrap_or(reference);
 call_service_rpc(state,"credit_wallet_funding",json!({
  "p_funding_id":id,"p_provider_reference":provider_ref,
  "p_channel":charge.get("channel").and_then(Value::as_str)
 })).await
}
async fn premium_activation(state:&AppState,reference:&str,expected_user:Option<i64>)->Result<Value,StatusCode>{
 let payment=row_by_reference(state,"premium_subscription_payments","id,user_id,reference,amount,currency,status",reference).await?.ok_or(StatusCode::NOT_FOUND)?;
 let user=payment.get("user_id").and_then(Value::as_i64).ok_or(StatusCode::BAD_GATEWAY)?;
 let amount=payment.get("amount").and_then(Value::as_f64).or_else(||payment.get("amount").and_then(Value::as_str).and_then(|v|v.parse().ok())).ok_or(StatusCode::BAD_GATEWAY)?;
 let currency=payment.get("currency").and_then(Value::as_str).unwrap_or("NGN");
 if expected_user.is_some_and(|expected|expected!=user){return Err(StatusCode::NOT_FOUND)}
 if payment.get("status").and_then(Value::as_str)==Some("SUCCESS"){return Ok(json!({"success":true,"alreadyActive":true,"reference":reference}))}
 if payment.get("status").and_then(Value::as_str)!=Some("PENDING"){return Err(StatusCode::CONFLICT)}
 let charge=verify_paystack(state,reference).await?;
 validate_payment(&charge,reference,amount,currency)?;
 call_service_rpc(state,"activate_premium_subscription",json!({
  "p_reference":reference,
  "p_provider_reference":charge.get("reference").and_then(Value::as_str).unwrap_or(reference)
 })).await
}

pub async fn verify_wallet(State(state):State<AppState>,headers:HeaderMap,Json(input):Json<VerifyReference>)->Response{
 let reference=input.reference.trim();
 if reference.len()<8||reference.len()>128||!reference.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'||c=='-'){return fail(StatusCode::BAD_REQUEST,"A valid payment reference is required.")}
 let auth=match auth_user_id(&state,&headers).await{Ok(v)=>v,Err(code)=>return fail(code,"Sign in to verify this funding request.")};
 let profile=match profile_id(&state,&auth).await{Ok(v)=>v,Err(code)=>return fail(code,"Your account profile could not be verified.")};
 match wallet_funding(&state,reference,Some(profile)).await{
  Ok(data)=>{let mut payload=json!({"success":true,"reference":reference,"data":data});if let Some(id)=data.get("funding_id").and_then(Value::as_i64){payload["fundingId"]=json!(id)};response(StatusCode::OK,payload)},
  Err(code)=>fail(code,match code{StatusCode::PAYMENT_REQUIRED=>"Payment has not succeeded.",StatusCode::NOT_FOUND=>"Funding request not found for this account.",StatusCode::CONFLICT=>"This funding request is no longer payable.",StatusCode::SERVICE_UNAVAILABLE=>"Wallet verification is not configured.",_=>"Wallet funding could not be verified."})
 }
}
pub async fn verify_premium(State(state):State<AppState>,headers:HeaderMap,Json(input):Json<VerifyReference>)->Response{
 let reference=input.reference.trim();
 if reference.len()<8||reference.len()>128||!reference.chars().all(|c|c.is_ascii_alphanumeric()||c=='_'||c=='-'){return fail(StatusCode::BAD_REQUEST,"A valid payment reference is required.")}
 let auth=match auth_user_id(&state,&headers).await{Ok(v)=>v,Err(code)=>return fail(code,"Sign in to verify this membership.")};
 let profile=match profile_id(&state,&auth).await{Ok(v)=>v,Err(code)=>return fail(code,"Your account profile could not be verified.")};
 match premium_activation(&state,reference,Some(profile)).await{
  Ok(data)=>response(StatusCode::OK,json!({"success":true,"reference":reference,"data":data})),
  Err(code)=>fail(code,match code{StatusCode::PAYMENT_REQUIRED=>"Payment has not succeeded.",StatusCode::NOT_FOUND=>"Membership payment not found for this account.",StatusCode::CONFLICT=>"This membership payment is no longer payable.",StatusCode::SERVICE_UNAVAILABLE=>"Membership verification is not configured.",_=>"Membership could not be verified."})
 }
}

pub async fn verify_wallet_event(state:&AppState,reference:&str)->Result<Value,StatusCode>{wallet_funding(state,reference,None).await}
pub async fn verify_premium_event(state:&AppState,reference:&str)->Result<Value,StatusCode>{premium_activation(state,reference,None).await}
