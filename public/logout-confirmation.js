export function createLogoutConfirmation({dialog,confirm,cancel,status,logout,t,errorText,now=()=>Date.now(),schedule=setInterval,unschedule=clearInterval}) {
  let timer=null,readyAt=0,busy=false;
  function stop(){if(timer!==null)unschedule(timer);timer=null;}
  function reset(){stop();readyAt=0;confirm.disabled=true;}
  function update(){
    const seconds=Math.max(0,Math.ceil((readyAt-now())/1000));
    confirm.textContent=t('แน่ใจ')+(seconds?' ('+seconds+')':'');
    confirm.disabled=busy || seconds>0;if(seconds===0)stop();
  }
  cancel.addEventListener('click',()=>{if(!busy){reset();dialog.close();}});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  dialog.addEventListener('close',reset);
  confirm.addEventListener('click',async()=>{
    if(busy || !dialog.open || !readyAt || now()<readyAt)return;
    busy=true;stop();confirm.disabled=cancel.disabled=true;
    try{await logout();dialog.close();}
    catch(error){status.textContent=errorText(error);}
    finally{busy=false;cancel.disabled=false;if(dialog.open)update();}
  });
  return function open(){
    if(busy || dialog.open)return;
    reset();status.textContent='';cancel.disabled=false;readyAt=now()+3000;
    update();dialog.showModal();timer=schedule(update,100);
  };
}
