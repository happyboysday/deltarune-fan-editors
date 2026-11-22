"""Display and control only the GameMaker child launched by this chapter project."""
import ctypes as ct
from ctypes import wintypes as wt
import io
import time
from PIL import Image

KEYS = {"up": 38, "down": 40, "left": 37, "right": 39, "act": 90, "cancel": 88,
        "menu": 67, "enter": 13, "escape": 27, "shift": 16, "space": 32}


class ChapterWindow:
    def __init__(self, process):
        self.process = process
        self.held = set()
        self.serial = -1
        self.error_poll_at=0;self.last_error=None
        self.user = ct.WinDLL("user32", use_last_error=True)
        self.gdi = ct.WinDLL("gdi32", use_last_error=True)
        self.callback = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        signatures = [
            (self.user, "GetWindowTextW",ct.c_int,[wt.HWND,wt.LPWSTR,ct.c_int]),
            (self.user, "EnumChildWindows",wt.BOOL,[wt.HWND,self.callback,wt.LPARAM]),
            (self.user, "SendMessageTimeoutW",ct.c_ssize_t,[wt.HWND,wt.UINT,wt.WPARAM,wt.LPARAM,wt.UINT,wt.UINT,ct.POINTER(ct.c_size_t)]),
            (self.user, "EnumWindows", wt.BOOL, [self.callback, wt.LPARAM]),
            (self.user, "GetWindowThreadProcessId", wt.DWORD, [wt.HWND,ct.POINTER(wt.DWORD)]),
            (self.user, "GetClientRect", wt.BOOL, [wt.HWND,ct.POINTER(wt.RECT)]),
            (self.user, "GetDC", wt.HDC, [wt.HWND]),
            (self.user, "ReleaseDC", ct.c_int, [wt.HWND,wt.HDC]),
            (self.user, "PrintWindow", wt.BOOL, [wt.HWND,wt.HDC,wt.UINT]),
            (self.user, "PostMessageW", wt.BOOL, [wt.HWND,wt.UINT,wt.WPARAM,wt.LPARAM]),
            (self.user, "MapVirtualKeyW", wt.UINT, [wt.UINT,wt.UINT]),
            (self.gdi, "CreateCompatibleDC", wt.HDC, [wt.HDC]),
            (self.gdi, "CreateCompatibleBitmap", wt.HBITMAP, [wt.HDC,ct.c_int,ct.c_int]),
            (self.gdi, "SelectObject", wt.HANDLE, [wt.HDC,wt.HANDLE]),
            (self.gdi, "GetBitmapBits", wt.LONG, [wt.HBITMAP,wt.LONG,ct.c_void_p]),
            (self.gdi, "DeleteDC", wt.BOOL,[wt.HDC]),
            (self.gdi, "DeleteObject", wt.BOOL,[wt.HANDLE]),
        ]
        for lib, name, result, args in signatures:
            call = getattr(lib,name)
            call.restype, call.argtypes = result,args

    def runtime_error(self):
        """Read a GameMaker error from our own game process without dismissing it."""
        if self.process.poll() is not None:return None
        now=time.monotonic()
        if now<self.error_poll_at:return self.last_error
        self.error_poll_at=now+.65
        messages=[]
        @self.callback
        def body(hwnd,_):
            buf=ct.create_unicode_buffer(8192);length=ct.c_size_t()
            if self.user.SendMessageTimeoutW(hwnd,0x000d,len(buf),ct.addressof(buf),2,80,ct.byref(length)):
                value=buf.value
                if "ERROR" in value.upper() and len(value)>35:
                    lines=[l.strip() for l in value.splitlines() if l.strip() and set(l.strip()) not in ({"_"},{"#"})]
                    messages.append("\n".join(lines))
            return True
        @self.callback
        def windows(hwnd,_):
            pid=wt.DWORD();self.user.GetWindowThreadProcessId(hwnd,ct.byref(pid))
            if pid.value!=self.process.pid:return True
            title=ct.create_unicode_buffer(128);self.user.GetWindowTextW(hwnd,title,len(title))
            if title.value=="Code Error":
                self.user.EnumChildWindows(hwnd,body,0)
                if not messages:messages.append("GameMaker Code Error")
                return False
            return True
        self.user.EnumWindows(windows,0)
        self.last_error=max(messages,key=len) if messages else None
        return self.last_error

    def window(self):
        if self.process.poll() is not None:
            raise ValueError("本次试玩已结束")
        found=[]
        @self.callback
        def inspect(hwnd,_):
            pid=wt.DWORD()
            self.user.GetWindowThreadProcessId(hwnd,ct.byref(pid))
            if pid.value == self.process.pid:
                rect=wt.RECT()
                if self.user.GetClientRect(hwnd,ct.byref(rect)) and rect.right>=160 and rect.bottom>=100:
                    found.append((hwnd,rect.right,rect.bottom))
            return True
        self.user.EnumWindows(inspect,0)
        if not found:
            raise ValueError("正在准备游戏窗口")
        return max(found,key=lambda item:item[1]*item[2])

    def input(self, serial, keys):
        if type(serial) is not int or not isinstance(keys,list) or any(k not in KEYS for k in keys):
            raise ValueError("无效的试玩输入")
        if serial<=self.serial:
            return
        hwnd,_,_=self.window()
        wanted=set(keys)
        for key in sorted(self.held-wanted):
            self.post(hwnd,key,False)
        for key in sorted(wanted-self.held):
            self.post(hwnd,key,True)
        self.held=wanted
        self.serial=serial

    def post(self,hwnd,key,down):
        code=KEYS[key]
        scan=self.user.MapVirtualKeyW(code,0)
        bits=1|(scan<<16)
        if code in (37,38,39,40):
            bits|=1<<24
        if not down:
            bits|=3<<30
        if not self.user.PostMessageW(hwnd,0x100 if down else 0x101,code,bits):
            raise ct.WinError(ct.get_last_error())

    def close(self):
        hwnd,_,_=self.window()
        for key in sorted(self.held):
            self.post(hwnd,key,False)
        self.held.clear()
        self.user.PostMessageW(hwnd,0x10,0,0)

    def frame(self):
        error=self.runtime_error()
        if error:raise ValueError("GameMaker 运行错误："+error)
        hwnd,w,h=self.window()
        if w*h>16777216:
            raise ValueError("窗口尺寸过大，请退出全屏再预览")
        dc=self.user.GetDC(hwnd)
        mem=self.gdi.CreateCompatibleDC(dc)
        bmp=self.gdi.CreateCompatibleBitmap(dc,w,h)
        old=self.gdi.SelectObject(mem,bmp)
        try:
            if not self.user.PrintWindow(hwnd,mem,3):
                raise ValueError("暂时无法读取试玩画面")
            pixels=ct.create_string_buffer(w*h*4)
            if self.gdi.GetBitmapBits(bmp,len(pixels),pixels)!=len(pixels):
                raise ValueError("尚未取得完整画面")
            frame=Image.frombytes("RGB",(w,h),pixels.raw,"raw","BGRX")
        finally:
            self.gdi.SelectObject(mem,old)
            self.gdi.DeleteObject(bmp)
            self.gdi.DeleteDC(mem)
            self.user.ReleaseDC(hwnd,dc)
        frame.thumbnail((960,720),Image.Resampling.NEAREST)
        result=io.BytesIO()
        frame.save(result,"PNG",compress_level=1)
        return result.getvalue()

