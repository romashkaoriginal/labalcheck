# Can the height of letters be refined below one pixel of a 300 dpi raster?
#
# Letters of an exactly known cap height are drawn large, reduced to 300 dpi at
# a random sub-pixel phase, blurred and JPEG-compressed like a proof, and then
# measured three ways:
#   whole pixels      rows of ink counted at 300 dpi (step 0.085 mm)
#   enlarged          the picture enlarged 2.4x with smoothing, rows counted
#                     (what the site does when it reads a line by itself)
#   grey edges        per column, where the tone crosses half-way between paper
#                     and ink, interpolated between pixels
# Printed for each: bias and root-mean-square error against the true height, mm.
#
# Result of the run recorded in README ("Точность размеров"): enlarging with
# smoothing halves the error of whole pixels (0.02-0.035 mm against 0.03-0.06 mm
# for capitals of 0.8-1.0 mm); grey edges are not better for letters under
# 1 mm (thin strokes never reach solid ink) and better only for large type;
# every method reads high by 0.01-0.05 mm, more for round letters, and lowercase
# text measures its x-height, 0.2 mm under the capitals. 0.80 and 0.85 mm cannot
# be told apart at 300 dpi by any of them.
#
# Needs Python with numpy and Pillow and three fonts with Cyrillic; not part of
# npm test.  FONTS=a.ttf;b.ttf python scripts/experiments/subpixel_height.py
import numpy as np,io,os,sys,random
from PIL import Image,ImageDraw,ImageFont,ImageFilter
random.seed(7);np.random.seed(7)
FONTS=[r'C:\Windows\Fonts\arialbd.ttf',r'C:\Windows\Fonts\arial.ttf',r'C:\Windows\Fonts\ARIALN.TTF']
FONTS=os.environ['FONTS'].split(';') if os.environ.get('FONTS') else FONTS
STEP=25.4/300
def draw(text,font_path,cap_px_hi):
    # find the font size whose cap height (letter "Н") is cap_px_hi pixels
    size=int(cap_px_hi*1.4)
    for _ in range(6):
        f=ImageFont.truetype(font_path,size);b=f.getbbox('Н');h=b[3]-b[1];size=max(4,int(round(size*cap_px_hi/h)))
    f=ImageFont.truetype(font_path,size);b=f.getbbox('Н');true=b[3]-b[1]
    w=int(f.getlength(text))+80;im=Image.new('L',(w,int(true*2.2)),255);d=ImageDraw.Draw(im);d.text((40,int(true*.5)-b[1]),text,font=f,fill=0)
    return np.array(im),true
def reduce(a,k,py,px,blur,quality):
    a=np.pad(a,((py,k),(px,k)),constant_values=255);H=(a.shape[0]//k)*k;W=(a.shape[1]//k)*k
    small=a[:H,:W].reshape(H//k,k,W//k,k).mean(axis=(1,3))
    im=Image.fromarray(small.astype(np.uint8))
    if blur:im=im.filter(ImageFilter.GaussianBlur(blur))
    if quality:
        buf=io.BytesIO();im.convert('RGB').save(buf,'JPEG',quality=quality);im=Image.open(io.BytesIO(buf.getvalue())).convert('L')
    return np.array(im).astype(float)
def hard(g,thr=150):
    rows=((g<thr).sum(axis=1)>=max(1,g.shape[1]*.025));ys=np.where(rows)[0];return ys[-1]-ys[0]+1 if len(ys) else np.nan
def fine(g):
    # per column: where the tone crosses half-way between paper and the darkest ink of that column,
    # from the top and from the bottom; the letter spans from the highest to the lowest crossing
    paper=np.percentile(g,95);tops=[];bots=[]
    for x in range(g.shape[1]):
        col=g[:,x];ink=col.min()
        if paper-ink<(paper-g.min())*.6:continue           # a column that never reaches solid ink
        half=(paper+ink)/2;idx=np.where(col<half)[0]
        if not len(idx):continue
        t=idx[0];b=idx[-1]
        if t>0:tops.append(t-(half-col[t])/(col[t-1]-col[t]) if col[t-1]>col[t] else t)
        if b<len(col)-1:bots.append(b+(half-col[b])/(col[b+1]-col[b]) if col[b+1]>col[b] else b)
    if len(tops)<3 or len(bots)<3:return np.nan
    tops.sort();bots.sort()
    # the flat tops and feet of letters: many columns share them
    return np.median(bots[-max(3,len(bots)//4):])-np.median(tops[:max(3,len(tops)//4)])
K=20
print('text      font    true mm | whole px (300dpi): bias  rms | x2.4 + threshold: bias  rms | grey edges: bias  rms   (mm)')
for text in ('НЕПТГШ','ОСЗЭОС','Состав','нептгш'):
  for fp in FONTS:
    for mm in (0.80,0.85,0.90,1.00,2.10):
        res={'h':[],'u':[],'f':[]}
        for trial in range(40):
            a,true=draw(text,fp,mm/STEP*K);truemm=true/K*STEP
            g=reduce(a,K,random.randrange(K),random.randrange(K),blur=random.choice([0.4,0.6,0.8]),quality=random.choice([80,90,95]))
            res['h'].append(hard(g)*STEP-truemm)
            up=np.array(Image.fromarray(g.astype(np.uint8)).resize((int(g.shape[1]*2.4),int(g.shape[0]*2.4)),Image.BICUBIC)).astype(float)
            res['u'].append(hard(up)*STEP/2.4-truemm)
            res['f'].append(fine(g)*STEP-truemm)
        s=lambda v:(np.nanmean(v),np.sqrt(np.nanmean(np.square(v))))
        print(f"{text:9s} {fp[-11:-4]:7s} {mm:.2f}   | {s(res['h'])[0]:+.3f} {s(res['h'])[1]:.3f}          | {s(res['u'])[0]:+.3f} {s(res['u'])[1]:.3f}          | {s(res['f'])[0]:+.3f} {s(res['f'])[1]:.3f}")
