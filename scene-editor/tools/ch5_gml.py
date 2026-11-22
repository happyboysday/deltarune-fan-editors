"""Recognize the narrow, source-auditable subset of GML used by scene imports."""
from dataclasses import dataclass
from functools import cache
import re
import json

TOKEN=re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|[A-Za-z_]\w*|\d+(?:\.\d+)?|==|!=|<=|>=|&&|\|\||[^\s]')
REL={"==":"eq","!=":"ne","<":"lt","<=":"le",">":"gt",">=":"ge"}
REV={"eq":"eq","ne":"ne","lt":"gt","le":"ge","gt":"lt","ge":"le"}
UNKNOWN=object()

@dataclass
class Node:
    code: str
    children: tuple = ()
    alternative: tuple = ()

class Parser:
    def __init__(self, source):
        self.tokens=[m[0] for m in TOKEN.finditer(source) if not m[0].startswith(("//","/*"))]
        self.i=0
    def peek(self):
        return self.tokens[self.i] if self.i<len(self.tokens) else None
    def take(self):
        v=self.peek()
        self.i+=1
        return v
    def bal(self, start, end):
        if self.take()!=start:
            raise ValueError(start)
        items=[]; depth=1
        while self.peek() is not None:
            t=self.take()
            if t==end:
                depth-=1
                if not depth:return " ".join(items)
            if t==start:depth+=1
            items.append(t)
        raise ValueError(end)
    def body(self):
        if self.peek()=="{":
            self.take()
            return self.block(True)
        return (self.node(),)
    def block(self,close=False):
        out=[]
        while self.peek() is not None:
            if close and self.peek()=="}":
                self.take()
                break
            out.append(self.node())
        return tuple(out)
    def node(self):
        first=self.take()
        if first in ("if","with","for","while","switch","repeat") and self.peek()=="(":
            guard=self.bal("(",")")
            children=self.body()
            alternative=()
            if first=="if" and self.peek()=="else":
                self.take();alternative=self.body()
            return Node(first+" "+guard,children,alternative)
        if first=="{":
            return Node("block",self.block(True))
        if first in ("case","default"):
            parts=[first]
            while self.peek() not in (None,":","}"):parts.append(self.take())
            if self.peek()==":":self.take()
            return Node(" ".join(parts))
        if first in (None,";","}"):
            return Node("")
        parts=[first]
        while self.peek() not in (None,";","}"):
            t=self.peek()
            if t=="(":parts.extend(("(",self.bal("(",")"),")"))
            elif t=="[":parts.extend(("[",self.bal("[","]"),"]"))
            elif t=="{":
                content=self.bal("{","}")
                if first.startswith("function") or "function" in parts:
                    return Node(" ".join(parts),parse(content))
                parts.extend(("{",content,"}"))
            else:parts.append(self.take())
        if self.peek()==";":self.take()
        return Node(" ".join(parts))

@cache
def parse(s):
    return Parser(s).block()

def split_op(s, delimiter):
    depths=0
    start=0
    out=[]
    for t in TOKEN.finditer(s):
        if t[0] in ("(","[","{"):depths+=1
        elif t[0] in (")","]","}"):depths-=1
        elif depths==0 and t[0]==delimiter:
            out.append(s[start:t.start()].strip());start=t.end()
    return out+[s[start:].strip()]

def scalar(s,ctx):
    s=s.strip()
    if s in ctx:return ctx[s]
    if s.startswith('"') and re.fullmatch(r'"(?:\\.|[^"\\])*"',s):
        try:return json.loads(s)
        except ValueError:return s[1:-1]
    if re.fullmatch(r'-?\s*\d+',s):return int(s.replace(" ",""))
    if re.fullmatch(r'-?\s*\d+\.\d+',s):return float(s.replace(" ",""))
    if s in ("true","false"):return s=="true"
    if s.startswith("room_") and re.fullmatch(r"\w+",s):return s
    return UNKNOWN

def flag(s):
    matches=re.fullmatch(r'(?:scr_flag_get\s*\(\s*(\d+)\s*\)|global\s*\.\s*flag\s*\[\s*(\d+)\s*\])',s)
    if matches:return "gml_f_"+(matches[1] or matches[2])
    if re.fullmatch(r'global\s*\.\s*plot',s):return "gml_plot"
    return None

def condition(s, ctx):
    s=s.strip()
    if s.startswith("(") and s.endswith(")") and len(split_op(s[1:-1],")"))==1:
        # Remove wrapping parentheses only when the inside is balanced.
        tokens=[t[0] for t in TOKEN.finditer(s)]
        depth=0
        for n,t in enumerate(tokens):
            if t=="(":depth+=1
            elif t==")":
                depth-=1
                if depth==0:
                    if n==len(tokens)-1:return condition(s[1:-1],ctx)
                    break
    for delim,op in (("||","any"),("&&","all")):
        parts=split_op(s,delim)
        if len(parts)>1:
            values=[condition(p,ctx) for p in parts]
            terminal=False if op=="all" else True
            if any(v is terminal for v in values):return terminal
            if any(v is UNKNOWN for v in values):return UNKNOWN
            rest=[v for v in values if type(v) is not bool]
            return (not terminal) if not rest else rest[0] if len(rest)==1 else {op:rest}
    if s.startswith("!"):
        return negate(condition(s[1:],ctx))
    for op,cmp in REL.items():
        parts=split_op(s,op)
        if len(parts)!=2:continue
        l,r=parts
        a,b=scalar(l,ctx),scalar(r,ctx)
        if a is not UNKNOWN and b is not UNKNOWN:
            if cmp=="eq":return a==b
            if cmp=="ne":return a!=b
            if isinstance(a,(int,float)) and isinstance(b,(int,float)):
                return {"lt":a<b,"le":a<=b,"gt":a>b,"ge":a>=b}[cmp]
            return UNKNOWN
        if flag(l) and b is not UNKNOWN:return {"flag":flag(l),"compare":cmp,"is":b}
        if flag(r) and a is not UNKNOWN:return {"flag":flag(r),"compare":REV[cmp],"is":a}
        return UNKNOWN
    a=scalar(s,ctx)
    if a is not UNKNOWN:return bool(a)
    return UNKNOWN

def negate(v):
    if v is UNKNOWN:return v
    return not v if type(v) is bool else {"not":v}

def combine(a,b):
    if a is False or b is False:return False
    if a is True:return b
    if b is True:return a
    return {"all":[a,b]}

def flatten(nodes,ctx,guard=True,ignore_unknown=False):
    """Resolve static guards and carry supported dynamic guards with their statements."""
    for n in nodes:
        if n.code.startswith("if "):
            c=condition(n.code[3:],ctx)
            if c is UNKNOWN:
                if not ignore_unknown:yield guard,n,False
                continue
            for group,v in ((n.children,c),(n.alternative,negate(c))):
                applied=combine(guard,v)
                if applied is not False:yield from flatten(group,ctx,applied,ignore_unknown)
        elif n.code=="block":
            yield from flatten(n.children,ctx,guard,ignore_unknown)
        else:
            yield guard,n,not bool(n.children)

def serialize(src):
    # Tokenization makes assignment matching independent of whitespace.
    return " ".join(m[0] for m in TOKEN.finditer(src) if not m[0].startswith(("//","/*")))

LOC=re.compile(r'\b(?:msgsetloc|msgnextloc|stringsetloc)\s*\((?:\s*\d+\s*,)?\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")')

def dialogue(raw):
    raw=re.sub(r'\^\d+','',raw)
    raw=re.sub(r'\\(?:[FEfe][0-9A-Za-z]+|c[0-9A-Za-z]|[TtMm]\d+|[A-Za-z][0-9])','',raw)
    raw=re.sub(r'/[%^]?$','',raw).replace("&","\n")
    return raw.strip()

def messages(stmt, lang):
    out=[]
    for m in LOC.finditer(stmt):
        raw,key=(scalar(x,{}) for x in m.groups())
        text=dialogue(lang.get(key,raw))
        if text and "[NO TEXT]" not in text and "Suddenly, your body seizes up" not in text:
            out.append((text,key))
    return out

