"""Optional real-time capture for the native navigation check."""
import io, math, os, subprocess, time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

class Clip:
    def __init__(self,path,binary,n):
        self.out=subprocess.Popen([str(binary),"-nostdin","-loglevel","error","-y","-f","rawvideo","-pix_fmt","rgb24","-s","640x548","-r","15","-i","pipe:0","-an","-c:v","libx264","-preset","veryfast","-crf","20","-pix_fmt","yuv420p","-movflags","+faststart",str(path)],stdin=subprocess.PIPE,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        self.font=ImageFont.truetype(str(Path(os.environ["WINDIR"])/"Fonts/msyh.ttc"),16)
        self.n=n;self.start=None;self.count=0;self.previous=None

    def capture(self,ch,nav,state):
        if not state or not state["player"]:return
        now=time.monotonic()
        if self.start is None:self.start=now
        frame=math.floor((now-self.start)*15)
        if self.count>frame:return
        pic=Image.open(io.BytesIO(ch.window.frame())).convert("RGB")
        pic.thumbnail((640,480),Image.Resampling.NEAREST)
        canvas=Image.new("RGB",(640,548),"#181722");canvas.paste(pic,((640-pic.width)//2,0))
        draw=ImageDraw.Draw(canvas)
        keys={"left":"←","right":"→","up":"↑","down":"↓","act":"Z","cancel":"X"}
        keys=" ".join(keys.get(k,k) for k in sorted(ch.window.held)) or "—"
        draw.text((12,487),f"AI 自动跑图  ·  第 {self.n} 章      实际按键：{keys}",font=self.font,fill="#f8e9a4")
        msg=nav["note"].replace("room_dw_cliff_seth_miniboss","Seth 的房间")
        draw.text((12,517),msg,font=self.font,fill="#e2dcec")
        data=canvas.tobytes()
        while self.count<frame and self.previous is not None:self.out.stdin.write(self.previous);self.count+=1
        self.out.stdin.write(data);self.count+=1;self.previous=data

    def close(self):
        if self.previous:
            for _ in range(12):self.out.stdin.write(self.previous)
        self.out.stdin.close()
        if self.out.wait(20):raise RuntimeError("录像编码失败")

