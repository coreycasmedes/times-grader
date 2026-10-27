import random, json, os, glob, numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
DPI=150; PW,PH=int(8.5*DPI),int(11*DPI)
def _font_dir():
    for d in ['/usr/share/fonts/truetype/dejavu/', '/Library/Fonts/', os.path.expanduser('~/Library/Fonts/')]:
        if os.path.exists(os.path.join(d, 'DejaVuSans.ttf')): return d
    hits = glob.glob('/usr/share/fonts/**/DejaVuSans.ttf', recursive=True)
    if hits: return os.path.dirname(hits[0]) + '/'
    raise SystemExit('Install the DejaVu fonts (DejaVuSans.ttf) to generate test worksheets.')
F=_font_dir()
fT=ImageFont.truetype(F+'DejaVuSans-Bold.ttf',40); fP=ImageFont.truetype(F+'DejaVuSans.ttf',34)
fH=[ImageFont.truetype(F+'DejaVuSans-Oblique.ttf',40),ImageFont.truetype(F+'DejaVuSerif-Italic.ttf',42),ImageFont.truetype(F+'DejaVuSans-BoldOblique.ttf',38)]
def problems(seed, n=30):
    r=random.Random(seed); return [(r.randint(2,12),r.randint(2,12)) for _ in range(n)]
def worksheet(probs, answers, name, rnd):
    im=Image.new('L',(PW,PH),246); d=ImageDraw.Draw(im)
    d.text((90,70),'Multiplication Facts — Practice 4',font=fT,fill=20)
    d.text((90,150),'Name:',font=fP,fill=30); d.line([(210,185),(700,185)],fill=60,width=2)
    hf=rnd.choice(fH)
    d.text((230,135),name,font=hf,fill=55)
    pts=[]
    for i,(a,b) in enumerate(probs):
        col,row=i%3,i//3; x=110+col*380; y=290+row*125
        d.text((x,y),f'{i+1}.',font=fP,fill=110)
        d.text((x+60,y),f'{a} × {b} =',font=fP,fill=25)
        d.line([(x+235,y+44),(x+340,y+44)],fill=90,width=2)
        ans=answers[i]
        if ans!='':
            tx=x+245+rnd.randint(-5,5); ty=y-4+rnd.randint(-4,4)
            layer=Image.new('L',(160,80),0); ImageDraw.Draw(layer).text((10,10),ans,font=hf,fill=255)
            layer=layer.rotate(rnd.uniform(-8,8),resample=Image.BILINEAR)
            im.paste(Image.new('L',layer.size,rnd.choice([40,55,70])),(tx,ty),layer)
        pts.append(((x+288)/PW*1000,(y+22)/PH*1000))
    return im, pts
def student(seed, probs, wrong_rate=0.15, blank_rate=0.03):
    r=random.Random(seed); ans=[]; truth=[]
    for a,b in probs:
        p=a*b; u=r.random()
        if u<blank_rate: ans.append(''); truth.append(False)
        elif u<blank_rate+wrong_rate: w=p+r.choice([-1,1,2,-2,10,-10,a,-a]); ans.append(str(max(1,w))); truth.append(False)
        else: ans.append(str(p)); truth.append(True)
    return ans, truth
def photo(sheet, W, H, rnd, tilt=0.1, blur=1.0, scale=(0.72,0.9), bg=85):
    sw,sh=sheet.size; s=min(W/sw,H/sh)*rnd.uniform(*scale); cw,ch=sw*s,sh*s
    ox=(W-cw)/2+rnd.uniform(-0.04,0.04)*W; oy=(H-ch)/2+rnd.uniform(-0.03,0.03)*H
    j=lambda: rnd.uniform(-tilt,tilt)*min(cw,ch)*0.5
    dst=[(ox+j(),oy+j()),(ox+cw+j(),oy+j()),(ox+cw+j(),oy+ch+j()),(ox+j(),oy+ch+j())]
    src=[(0,0),(sw,0),(sw,sh),(0,sh)]
    A=[];B=[]
    for (x,y),(u,v) in zip(dst,src):
        A.append([x,y,1,0,0,0,-u*x,-u*y]); B.append(u); A.append([0,0,0,x,y,1,-v*x,-v*y]); B.append(v)
    co=tuple(np.linalg.solve(np.array(A),np.array(B)))
    bgim=Image.fromarray(np.clip(np.full((H,W),bg,np.float32)+np.random.normal(0,7,(H,W)),0,255).astype(np.uint8))
    warped=sheet.transform((W,H),Image.PERSPECTIVE,co,Image.BILINEAR,fillcolor=0)
    mask=Image.new('L',sheet.size,255).transform((W,H),Image.PERSPECTIVE,co,Image.BILINEAR,fillcolor=0)
    out=np.asarray(Image.composite(warped,bgim,mask)).astype(np.float32)
    yy,xx=np.mgrid[0:H,0:W]; out*=0.78+0.22*(xx/W)+0.06*(yy/H)
    out+=np.random.normal(0,3,out.shape)
    img=Image.fromarray(np.clip(out,0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur)).convert('RGB')
    return img,[list(p) for p in dst]
