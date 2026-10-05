$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase,System.Drawing
Add-Type -ReferencedAssemblies ([System.Diagnostics.Process].Assembly.Location),([System.Collections.Generic.HashSet[int]].Assembly.Location),([System.Windows.Automation.AutomationElement].Assembly.Location),([System.Windows.Automation.ControlType].Assembly.Location),([System.Windows.Rect].Assembly.Location),([System.Drawing.Bitmap].Assembly.Location) -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;
public static class IrisWin {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  static IrisWin() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch {} }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr reserved,peb,r1,r2,pid,ppid; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll",EntryPoint="GetWindowTextW",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr z,int x,int y,int w,int t,uint f);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint f);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,IntPtr unused);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int a,out int v,int size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint rights,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr address,byte[] data,int size,out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h,out bool wow);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h,int cls,ref PBI p,int len,out int returned);
  [ComImport,Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A")] class DesktopManager {}
  [ComImport,Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDesktop {
    [PreserveSig] int Current(IntPtr h,[MarshalAs(UnmanagedType.Bool)] out bool current);
    [PreserveSig] int Id(IntPtr h,out Guid id);
    [PreserveSig] int Move(IntPtr h,ref Guid id);
  }
  static IDesktop Desktop() { return (IDesktop)new DesktopManager(); }
  public static Dictionary<string,object>[] Windows() {
    var list = new List<Dictionary<string,object>>(); IDesktop desktop=null;
    try { desktop=Desktop(); } catch {}
    EnumWindows(delegate(IntPtr h,IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var b=new StringBuilder(4096); GetWindowText(h,b,b.Capacity); if (b.Length==0) return true;
      Rect r; if (!GetWindowRect(h,out r) || r.right-r.left<80 || r.bottom-r.top<60) return true;
      uint pid; GetWindowThreadProcessId(h,out pid); string name="",exe="",start="";
      try { var p=Process.GetProcessById((int)pid); name=p.ProcessName; start=p.StartTime.ToUniversalTime().ToString("o"); } catch {}
      try { exe=Process.GetProcessById((int)pid).MainModule.FileName; } catch {}
      int cloaked=0; try { DwmGetWindowAttribute(h,14,out cloaked,4); } catch {}
      bool current=cloaked==0; Guid desk=Guid.Empty;
      if(desktop!=null) { try { desktop.Current(h,out current); desktop.Id(h,out desk); } catch {} }
      var row=new Dictionary<string,object>();
      row["id"]=h.ToInt64(); row["cgId"]=h.ToInt64(); row["pid"]=(int)pid; row["pidStart"]=start;
      row["matchApp"]=name; row["appKey"]=exe.Length>0?exe.ToLowerInvariant():"pid:"+pid;
      row["exe"]=exe; row["matchTitle"]=b.ToString(); row["bounds"]=new int[]{r.left,r.top,r.right-r.left,r.bottom-r.top};
      row["onScreen"]=current&&!IsIconic(h)&&cloaked==0; row["reachable"]="cg"; row["idConfidence"]="exact";
      row["desktopId"]=desk==Guid.Empty?null:desk.ToString(); row["onCurrent"]=current; row["minimized"]=IsIconic(h); row["z"]=list.Count;
      list.Add(row); return true;
    },IntPtr.Zero);
    if(desktop!=null) Marshal.ReleaseComObject(desktop);
    return list.ToArray();
  }
  public static long Front() { return GetForegroundWindow().ToInt64(); }
  static IntPtr Checked(long id,int pid,string start) {
    var h=new IntPtr(id); uint actual;
    if(!IsWindow(h)) throw new Exception("window-gone"); GetWindowThreadProcessId(h,out actual);
    if(pid<=0 || actual!=pid) throw new Exception("window-identity-changed");
    if(String.IsNullOrEmpty(start)) throw new Exception("process-identity-unavailable");
    if(Process.GetProcessById(pid).StartTime.ToUniversalTime().ToString("o")!=start) throw new Exception("process-identity-changed");
    return h;
  }
  public static bool Focus(long id,int pid,string start) {
    var h=Checked(id,pid,start); bool current; var d=Desktop();
    try { if(d.Current(h,out current)!=0||!current) throw new Exception("desktop-switch-unsupported"); } finally { Marshal.ReleaseComObject(d); }
    ShowWindow(h,9); uint ours=GetCurrentThreadId(), fg=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero);
    bool attached=fg!=0&&fg!=ours&&AttachThreadInput(ours,fg,true);
    try { SetForegroundWindow(h); return GetForegroundWindow()==h; } finally { if(attached) AttachThreadInput(ours,fg,false); }
  }
  public static int[] Move(long id,int pid,string start,int x,int y,int w,int hgt) {
    var h=Checked(id,pid,start); if(w<80||hgt<60||w>50000||hgt>50000) throw new Exception("invalid-bounds");
    if(IsIconic(h)) ShowWindow(h,9);
    if(!SetWindowPos(h,IntPtr.Zero,x,y,w,hgt,0x14)) throw new Exception("window-move-failed");
    Rect r; if(!GetWindowRect(h,out r)) throw new Exception("window-gone"); return new int[]{r.left,r.top,r.right-r.left,r.bottom-r.top};
  }
  public static int PointPid(int x,int y) { uint pid; GetWindowThreadProcessId(GetAncestor(WindowFromPoint(new Point{x=x,y=y}),2),out pid); return (int)pid; }
  static byte[] Read(IntPtr h,IntPtr a,int size) {
    if(a==IntPtr.Zero||size<=0||size>65536) throw new Exception("invalid-process-address");
    var b=new byte[size]; IntPtr read; if(!ReadProcessMemory(h,a,b,size,out read)||read.ToInt64()!=size) throw new Exception("process-read-denied"); return b;
  }
  static IntPtr Ptr(byte[] b,int offset) { return IntPtr.Size==8?new IntPtr(BitConverter.ToInt64(b,offset)):new IntPtr(BitConverter.ToInt32(b,offset)); }
  // PEB 읽기: 동일 비트 수·읽기 전후 동일 값
  public static string Cwd(int pid) {
    var h=OpenProcess(0x410,false,pid); if(h==IntPtr.Zero) throw new Exception("process-access-denied");
    try {
      bool wow,ownWow; if(!IsWow64Process(h,out wow)||!IsWow64Process(Process.GetCurrentProcess().Handle,out ownWow)||wow!=ownWow) throw new Exception("process-bitness-mismatch");
      var info=new PBI(); int ret; if(NtQueryInformationProcess(h,0,ref info,Marshal.SizeOf(typeof(PBI)),out ret)!=0) throw new Exception("process-query-denied");
      int paramOffset=IntPtr.Size==8?0x20:0x10, cwdOffset=IntPtr.Size==8?0x38:0x24;
      var parameters=Ptr(Read(h,IntPtr.Add(info.peb,paramOffset),IntPtr.Size),0);
      var before=Read(h,IntPtr.Add(parameters,cwdOffset),IntPtr.Size==8?16:8);
      int len=BitConverter.ToUInt16(before,0),max=BitConverter.ToUInt16(before,2);
      if(len==0||len%2!=0||len>max||max>65534) throw new Exception("invalid-cwd");
      var value=Encoding.Unicode.GetString(Read(h,Ptr(before,IntPtr.Size==8?8:4),len));
      var after=Read(h,IntPtr.Add(parameters,cwdOffset),before.Length);
      if(!Convert.ToBase64String(before).Equals(Convert.ToBase64String(after))) throw new Exception("cwd-changed");
      if(!System.IO.Path.IsPathRooted(value)||value.IndexOf('\0')>=0) throw new Exception("invalid-cwd"); return value;
    } finally { CloseHandle(h); }
  }
  static AutomationElement[] Roots(int pid) {
    var found=AutomationElement.RootElement.FindAll(TreeScope.Children,new PropertyCondition(AutomationElement.ProcessIdProperty,pid));
    var rows=new AutomationElement[found.Count]; for(int i=0;i<found.Count;i++) rows[i]=found[i]; return rows;
  }
  public static object[] Describe(int pid) {
    var rows=new List<object>(); foreach(var root in Roots(pid)) {
      var buttons=new List<string>(); var texts=new List<string>();
      var found=root.FindAll(TreeScope.Descendants,Condition.TrueCondition);
      for(int i=0;i<found.Count&&i<2000;i++) {
        var c=found[i].Current; if(c.ControlType==ControlType.Button && c.Name.Length>0) buttons.Add(c.Name);
        if(c.ControlType==ControlType.Text && c.Name.Length>0) texts.Add(c.Name);
      }
      object wp; bool modal=root.TryGetCurrentPattern(WindowPattern.Pattern,out wp)&&((WindowPattern)wp).Current.IsModal;
      rows.Add(new Dictionary<string,object>{{"name",root.Current.Name},{"kind",modal?"sheet":"window"},{"buttons",buttons.ToArray()},{"text",String.Join(" ",texts.ToArray())}});
    } return rows.ToArray();
  }
  public static void Click(int pid,string name) {
    var hits=new List<AutomationElement>(); foreach(var root in Roots(pid)) {
      var found=root.FindAll(TreeScope.Descendants,new AndCondition(new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button),new PropertyCondition(AutomationElement.NameProperty,name)));
      for(int i=0;i<found.Count;i++) if(found[i].Current.IsEnabled&&!found[i].Current.IsOffscreen) hits.Add(found[i]);
    }
    if(hits.Count!=1) throw new Exception(hits.Count==0?"button-not-found":"ambiguous-button");
    object pattern; if(!hits[0].TryGetCurrentPattern(InvokePattern.Pattern,out pattern)) throw new Exception("button-not-invokable"); ((InvokePattern)pattern).Invoke();
  }
  public static void Key(int pid,string key) {
    uint actual; var h=GetForegroundWindow(); GetWindowThreadProcessId(h,out actual); if(actual!=pid) throw new Exception("app-not-foreground");
    var root=AutomationElement.FromHandle(h); if(root==null) throw new Exception("window-not-found");
    var buttons=new List<AutomationElement>(); {
      var found=root.FindAll(TreeScope.Descendants,new PropertyCondition(AutomationElement.ControlTypeProperty,ControlType.Button));
      for(int i=0;i<found.Count;i++) { var c=found[i].Current; if(c.IsEnabled&&!c.IsOffscreen && ((key=="escape"&&c.AutomationId=="2")||(key=="enter"&&c.AutomationId=="1"))) buttons.Add(found[i]); }
    }
    if(buttons.Count!=1) throw new Exception("dialog-default-button-unavailable");
    if(GetForegroundWindow()!=h) throw new Exception("foreground-changed");
    object p; if(!buttons[0].TryGetCurrentPattern(InvokePattern.Pattern,out p)) throw new Exception("button-not-invokable"); ((InvokePattern)p).Invoke();
  }
  [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMEnumerator {}
  [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMEnumerator { [PreserveSig] int EnumEndpoints(int flow,uint mask,out IMMCollection devices); [PreserveSig] int Default(int flow,int role,out IMMDevice device);
  }
  [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-C0A0BB9F5C59"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMCollection { [PreserveSig] int Count(out uint count); [PreserveSig] int Item(uint n,out IMMDevice device); }
  [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IMMDevice { [PreserveSig] int Activate(ref Guid iid,uint cls,IntPtr parms,[MarshalAs(UnmanagedType.IUnknown)]out object obj); }
  [ComImport,Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionManager { [PreserveSig] int Control(ref Guid id,uint flags,out IntPtr c); [PreserveSig] int Volume(ref Guid id,uint flags,out IntPtr v); [PreserveSig] int Sessions(out ISessionEnumerator sessions);
  }
  [ComImport,Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionEnumerator { [PreserveSig] int Count(out int count); [PreserveSig] int Item(int n,out ISessionControl c); }
  [ComImport,Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionControl { [PreserveSig] int State(out int s); [PreserveSig] int Name(out IntPtr s); [PreserveSig] int SetName([MarshalAs(UnmanagedType.LPWStr)]string s,ref Guid g); [PreserveSig] int Icon(out IntPtr s); [PreserveSig] int SetIcon([MarshalAs(UnmanagedType.LPWStr)]string s,ref Guid g); [PreserveSig] int Group(out Guid g); [PreserveSig] int SetGroup(ref Guid g,ref Guid c); [PreserveSig] int Register(IntPtr p); [PreserveSig] int Unregister(IntPtr p); [PreserveSig] int Identifier(out IntPtr s); [PreserveSig] int Instance(out IntPtr s); [PreserveSig] int Pid(out uint pid); [PreserveSig] int SystemSounds(); [PreserveSig] int Duck([MarshalAs(UnmanagedType.Bool)]bool disable);
  }
  [ComImport,Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISimpleVolume { [PreserveSig] int SetVolume(float v,ref Guid context); [PreserveSig] int GetVolume(out float v); [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)]bool mute,ref Guid context); [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)]out bool mute);
  }
  public static int Audio(int[] pids,float volume,bool muted) {
    if(volume<0||volume>1) throw new Exception("invalid-volume"); var selected=new HashSet<int>(pids); int applied=0;
    var enumerator=(IMMEnumerator)new MMEnumerator(); IMMCollection devices=null;
    try {
      Marshal.ThrowExceptionForHR(enumerator.EnumEndpoints(0,1,out devices)); uint count; devices.Count(out count);
      for(uint d=0;d<count;d++) { IMMDevice device=null; object manager=null; ISessionEnumerator sessions=null;
        try {
          devices.Item(d,out device); var iid=typeof(ISessionManager).GUID; device.Activate(ref iid,23,IntPtr.Zero,out manager);
          ((ISessionManager)manager).Sessions(out sessions); int n; sessions.Count(out n);
          for(int i=0;i<n;i++) { ISessionControl control=null; try {
            sessions.Item(i,out control); uint pid; control.Pid(out pid); if(!selected.Contains((int)pid)) continue;
            var v=(ISimpleVolume)control; Guid context=Guid.Empty; Marshal.ThrowExceptionForHR(v.SetVolume(volume,ref context)); Marshal.ThrowExceptionForHR(v.SetMute(muted,ref context)); applied++;
          } finally { if(control!=null) Marshal.ReleaseComObject(control); } }
        } finally { if(sessions!=null) Marshal.ReleaseComObject(sessions); if(manager!=null) Marshal.ReleaseComObject(manager); if(device!=null) Marshal.ReleaseComObject(device); }
      }
    } finally { if(devices!=null) Marshal.ReleaseComObject(devices); Marshal.ReleaseComObject(enumerator); } return applied;
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $r = $null
  try {
    $r = $line | ConvertFrom-Json
    $out = @{ id = $r.id; ok = $true }
    switch ($r.op) {
      'processes' {
        $out.processes = @(Get-CimInstance Win32_Process | Where-Object { !$r.pids -or $_.ProcessId -in $r.pids } | ForEach-Object {
          $proc = $_
          $cwd = $null; $status = 'unavailable'; $start = ''
          try { $cwd = [IrisWin]::Cwd([int]$proc.ProcessId); $status = 'known' } catch { $status = $_.Exception.GetBaseException().Message }
          try { $start = (Get-Process -Id $proc.ProcessId).StartTime.ToUniversalTime().ToString('o') } catch {}
          @{ pid = [int]$proc.ProcessId; ppid = [int]$proc.ParentProcessId; command = [string]$proc.CommandLine; name = [string]$proc.Name; exe = [string]$proc.ExecutablePath; cwd = $cwd; cwdStatus = $status; start = $start }
        })
      }
      'portPid' {
        $owners = @(Get-NetTCPConnection -LocalPort ([int]$r.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -ne 1) { throw 'ambiguous-listener' }
        $out.pid = [int]$owners[0]
      }
      'portCwd' {
        $owners = @(Get-NetTCPConnection -LocalPort ([int]$r.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -ne 1) { throw 'ambiguous-listener' }
        $owner = [int]$owners[0]
        $before = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
        if (!$before) { throw 'process-gone' }
        $out.cwd = [IrisWin]::Cwd($owner)
        $after = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
        if (!$after -or $before.CreationDate -ne $after.CreationDate) { throw 'process-identity-changed' }
        $currentOwners = @(Get-NetTCPConnection -LocalPort ([int]$r.port) -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
        if ($currentOwners.Count -ne 1 -or [int]$currentOwners[0] -ne $owner) { throw 'listener-changed' }
        if ($out.cwd -cne [IrisWin]::Cwd($owner)) { throw 'cwd-changed' }
        $out.pid = $owner; $out.command = [string]$after.CommandLine; $out.start = $after.CreationDate.ToUniversalTime().ToString('o')
      }
      'windows' { $out.windows = @([IrisWin]::Windows()); $out.front = [IrisWin]::Front() }
      'focus' { $out.focused = [IrisWin]::Focus([long]$r.hwnd,[int]$r.pid,[string]$r.start); if (!$out.focused) { throw 'foreground-denied' } }
      'move' { $out.bounds = [IrisWin]::Move([long]$r.hwnd,[int]$r.pid,[string]$r.start,[int]$r.bounds[0],[int]$r.bounds[1],[int]$r.bounds[2],[int]$r.bounds[3]) }
      'point' { $out.pid = [IrisWin]::PointPid([int]$r.x,[int]$r.y) }
      'describe' { $out.windows = @([IrisWin]::Describe([int]$r.pid)) }
      'click' { [IrisWin]::Click([int]$r.pid,[string]$r.button); $out.clicked = [string]$r.button }
      'key' { if ($r.key -notin @('enter','escape')) { throw 'invalid-key' }; [IrisWin]::Key([int]$r.pid,[string]$r.key) }
      'audio' { $out.applied = [IrisWin]::Audio([int[]]$r.pids,[float]$r.volume,[bool]$r.muted) }
      default { throw 'unknown-op' }
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 8 -Compress))
  } catch { [Console]::Out.WriteLine((@{ id = $r.id; ok = $false; error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress)) }
}
