using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

// Windows shows "Unknown app" in its media/now-playing flyout when the app that
// owns the media session has no resolvable identity. The fix Windows expects is:
// (1) set an explicit AppUserModelID on the process, and (2) have a Start-Menu
// shortcut that carries the SAME AppUserModelID + a display name + icon. Windows
// then resolves the id -> shortcut -> "holdonquietly" with our logo.
static class ShortcutHelper
{
    public static void EnsureShortcut(string aumid, string name, string exePath)
    {
        try
        {
            string dir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string lnk = Path.Combine(dir, name + ".lnk");

            var link = (IShellLinkW)new CShellLink();
            link.SetPath(exePath);
            link.SetIconLocation(exePath, 0);
            link.SetWorkingDirectory(Path.GetDirectoryName(exePath) ?? "");

            var store = (IPropertyStore)link;
            var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 }; // System.AppUserModel.ID
            InitPropVariantFromString(aumid, out var pv);
            store.SetValue(ref key, ref pv);
            store.Commit();
            PropVariantClear(ref pv);

            ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Save(lnk, true);
        }
        catch { }
    }

    [DllImport("propsys.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void InitPropVariantFromString(string psz, out PROPVARIANT ppropvar);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Sequential)]
struct PROPVARIANT { public ushort vt; ushort r1; ushort r2; ushort r3; public IntPtr p; public IntPtr p2; }

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
class CShellLink { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW
{
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint flags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIcon, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIcon, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore
{
    void GetCount(out uint cProps);
    void GetAt(uint iProp, out PROPERTYKEY pkey);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    void Commit();
}
