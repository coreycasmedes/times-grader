import json, random, os, sys, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
from PIL import Image, ImageDraw, ImageFont
from ws import DPI, PW, PH, F, fT, fP, problems, photo
X=[]; Y=[]
for d in range(10):
    a=np.array(json.load(open(os.path.join(ROOT, 'node_modules', 'mnist', 'src', 'digits', f'{d}.json')))['data'],np.float32).reshape(-1,28,28); X.append(a); Y+= [d]*len(a)
X=np.concatenate(X); Y=np.array(Y)
test_idx=json.load(open(os.path.join(ROOT, 'model', 'heldout_idx.json')))  # digits the model never trained on
pool={d:[i for i in test_idx if Y[i]==d] for d in range(10)}
def write_number(im, s, x, y, rnd, tight=False):
    cx=x
    for ch in s:
        img=X[rnd.choice(pool[int(ch)])]
        sz=rnd.randint(40,52)
        g=Image.fromarray((img*255).astype(np.uint8)).resize((sz,sz),Image.BILINEAR).rotate(rnd.uniform(-8,8),resample=Image.BILINEAR)
        shade=rnd.choice([35,50,65,80])
        im.paste(Image.new('L',g.size,shade),(int(cx),int(y+rnd.randint(-4,4))),g)
        cx+=sz*(rnd.uniform(0.55,0.66) if tight else rnd.uniform(0.6,0.8))
def worksheet(probs, answers, name, rnd, tight_set=()):
    im=Image.new('L',(PW,PH),246); d=ImageDraw.Draw(im)
    d.text((90,70),'Multiplication Facts — Practice 4',font=fT,fill=20)
    d.text((90,150),'Name:',font=fP,fill=30); d.line([(210,185),(700,185)],fill=60,width=2)
    d.text((230,140),name,font=ImageFont.truetype(F+'DejaVuSans-Oblique.ttf',36),fill=55)
    boxes=[]
    for i,(a,b) in enumerate(probs):
        col,row=i%3,i//3; x=110+col*380; y=290+row*125
        d.text((x,y),f'{i+1}.',font=fP,fill=110); d.text((x+60,y),f'{a} × {b} =',font=fP,fill=25)
        d.line([(x+235,y+44),(x+340,y+44)],fill=90,width=2)
        if answers[i]: write_number(im, answers[i], x+240+rnd.randint(-4,6), y-12, rnd, tight=i in tight_set)
        boxes.append([(x+232)/PW*1000,(y-16)/PH*1000,(x+345)/PW*1000,(y+50)/PH*1000])
    return im, boxes
