
from pathlib import Path
from PIL import Image, ImageDraw, ImageColor
root=Path(__file__).resolve().parents[1]/'studio'/'art'
root.mkdir(parents=True,exist_ok=True)
def im(w,h):return Image.new('RGBA',(w,h))
def save(img,key):img.save(root/(key+'.png'),optimize=True)
def sprite(rows,colors,scale=2):
    img=im(len(rows[0]),len(rows))
    for y,row in enumerate(rows):
        for x,v in enumerate(row):
            if v in colors:img.putpixel((x,y),ImageColor.getcolor(colors[v], "RGBA"))
    return img.resize((img.width*scale,img.height*scale),Image.Resampling.NEAREST)
palette={'1':'#171824','2':'#5f4a8d','3':'#a37bd5','4':'#d9b39e','5':'#e6ccbe','6':'#3e405e','7':'#8dbdba','8':'#579eae','9':'#365573','e':'#cba3c7'}
heads={
'down':['....1111....','..11222211..','..12333221..','.1223332211.','.1122232211.','..14444441..','..15454541..','...155551...'],
'up':['....1111....','..11222211..','..12333221..','.1223332211.','.1122232211.','..12232221..','..11222211..','...111111...'],
'left':['.....111....','...1122211..','..12333221..','..123322211.','..122322211.','..144422211.','.145542211..','..1155511...']}
for direction in ('down','up','left','right'):
    for frame in range(3):
        side=direction in ('left','right')
        top=heads['left' if side else direction]
        torso=(['...177111...','...1789911..','..14489961..','...116961...','....1661....'] if side else
              ['...177771...','..11888811..','..16888961..','..14888941..','...166661...'])
        feet=[['...16..61...','...11..11...','............'],['..166..61...','..111..11...','.......11...'],['...16..661..','...11..111..','...11.......']][frame]
        rows=top+torso+feet
        if direction=='right':rows=[x[::-1] for x in rows]
        save(sprite(rows,palette),f'walker-{direction}-{frame}')
def person(name,coat,hat,light):
    cols={**palette,'2':hat,'3':light,'8':coat}
    rows=['....1111....','...133331...','...133331...','..12333321..','.1111111111.','..14444441..','..14e4e441..','...155551...',
          '...177771...','..11888811..','..16888961..','..14888941..','...166661...','...16..61...','...11..11...','............']
    save(sprite(rows,cols),name)
    if name=='foreman':
        pic=im(42,42);d=ImageDraw.Draw(pic)
        d.rectangle((0,0,41,41),fill='#282439');d.rectangle((1,1,40,40),outline='#655475')
        face=sprite(rows,cols,3)
        pic.alpha_composite(face,(3,3))
        save(pic,'foreman-face')
person('foreman','#617d9c','#825d67','#d0a388')
person('stagehand','#81447e','#643975','#e78dbe')
save(sprite(['............','......11....','....11711...','...1771771..','..1771.171..','..171..11...','...11.91....','.....191....','.....191....','....19991...','...1111111..'],
 {'1':'#173e38','7':'#9aeba9','9':'#52a280'}),'sprout')
for i in range(2):
    save(sprite(['..1111..','.176671.','.176671.','.176671.','..1111..','...11...'],
      {'1':'#463747','6':['#dda476','#ffe4ab'][i],'7':'#af877e'}),f'lantern-{i}')
