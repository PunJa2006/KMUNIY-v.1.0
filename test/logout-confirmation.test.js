import test from 'node:test';
import assert from 'node:assert/strict';
import {createLogoutConfirmation} from '../public/logout-confirmation.js';
test('logout failures stay in the dialog and double-clicks or Escape cannot interrupt a pending sign out',async()=>{
 const node=()=>({handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}}),dialog=node(),confirm=node(),cancel=node(),status=node();
 dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.handlers.close();};
 let clock=1000,logoutCalls=0,resolveLogout,fail=true;
 const open=createLogoutConfirmation({dialog,confirm,cancel,status,t:source=>source,errorText:()=> 'ลองอีกครั้ง',now:()=>clock,schedule:()=>1,unschedule:()=>{},logout:async()=>{logoutCalls++;if(fail)throw Error('offline');await new Promise(resolve=>resolveLogout=resolve);}});
 open();clock+=3000;await confirm.handlers.click();assert.equal(status.textContent,'ลองอีกครั้ง');assert.equal(dialog.open,true);assert.equal(confirm.disabled,false);
 fail=false;const pending=confirm.handlers.click();await confirm.handlers.click();cancel.handlers.click();let prevented=false;dialog.handlers.cancel({preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(dialog.open,true);assert.equal(logoutCalls,2);resolveLogout();await pending;assert.equal(dialog.open,false);
});
