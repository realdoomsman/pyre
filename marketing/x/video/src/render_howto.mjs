import { execFileSync } from "node:child_process";
import fs from "node:fs";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const H = "C:/tech/ship/marketing/x/video/src/howto.html";
const PROF = "C:/tech/ship/marketing/x/_cliprof";
const FR = "C:/tech/ship/marketing/x/video/frames_howto";
const FPS = 24;
const scenes = [["title",3.8],["s1",4.6],["s2",4.6],["s3",4.6],["s4",4.6],["s5",4.6],["s6",4.6],["end",4.2]];
let total=0; for(const [,d] of scenes) total+=Math.round(d*FPS);
console.log("total", total);
let done=0;
for(const [scene,dur] of scenes){
  const dir=`${FR}/${scene}`; fs.mkdirSync(dir,{recursive:true});
  const n=Math.round(dur*FPS);
  for(let i=0;i<n;i++){
    const t=(i/FPS).toFixed(4);
    execFileSync(CHROME,["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars","--force-device-scale-factor=1",`--user-data-dir=${PROF}`,"--window-size=1920,1080","--virtual-time-budget=900",`--screenshot=${dir}/f${String(i).padStart(4,"0")}.png`,`file:///${H}?scene=${scene}&t=${t}`],{stdio:"ignore",timeout:30000});
    done++; if(done%50===0) console.log(`${done}/${total} (${scene} ${i+1}/${n})`);
  }
  console.log("scene done", scene, n);
}
console.log("HOWTO FRAMES DONE", done);
