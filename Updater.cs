using System;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;

// ─────────────────────────────────────────────────────────────────────────────
// Silent auto-updater. On startup (only for the DISTRIBUTED single-file exe, never
// the dev build) it checks the latest GitHub release, and if it's newer than the
// running <Version>, downloads the new .exe in the background and stages a swap.
// Because a running .exe is locked, the swap is done by a tiny .cmd that waits for
// this process to exit, replaces the exe, and relaunches it. The page shows a small
// toast when an update is ready (click = restart & finish) and again after a
// successful update ("Updated to vX"). Nothing is forced — download is silent.
// ─────────────────────────────────────────────────────────────────────────────
static class Updater
{
    // The public releases repo the app pulls updates from. A public repo means the
    // release .exe asset downloads with no auth/token embedded in the app.
    const string REPO = "dwindles/holdonquietly-soundcloud";
    const string EXE = "holdonquietly.exe";
    const string NEW_EXE = "holdonquietly.new.exe";
    const string CMD = "hoq-update.cmd";

    static readonly HttpClient http = new HttpClient();

    // Set by Program so the updater can talk to the page (show toasts) and to
    // trigger an app restart when the user clicks "restart to finish".
    public static Action<string> RunJs;          // executes a JS string on the page
    public static Action ApplyAndRestart;        // launches the swap cmd + quits the app

    static string exeDir;
    static bool pending;                          // an update .exe is staged & ready

    public static bool IsPending => pending;

    // Kick off from Init(). Never throws into the caller.
    public static void Start(string userData)
    {
        try { _ = RunAsync(userData); } catch { }
    }

    static async Task RunAsync(string userData)
    {
        try
        {
            exeDir = AppContext.BaseDirectory;

            // Dev-build guard: the framework-dependent build has holdonquietly.dll
            // beside the exe; the published single-file exe does not. Only self-update
            // the real distributable so we never clobber a dev build with a release.
            if (File.Exists(Path.Combine(exeDir, "holdonquietly.dll"))) return;

            var cur = Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0, 0);

            // "Notify after": if this launch is running a newer version than we last
            // recorded, an update just applied — tell the user.
            try
            {
                string vf = Path.Combine(userData, "version.txt");
                Version last = null;
                if (File.Exists(vf)) Version.TryParse(File.ReadAllText(vf).Trim(), out last);
                if (last != null && cur > last)
                    RunJs?.Invoke("window.__hoqUpdate && window.__hoqUpdate('done'," + JsStr(VerStr(cur)) + ")");
                Directory.CreateDirectory(userData);
                File.WriteAllText(vf, VerStr(cur));
            }
            catch { }

            // Clean up a stale staged exe from a previous run that never applied.
            try { var np = Path.Combine(exeDir, NEW_EXE); if (File.Exists(np)) File.Delete(np); } catch { }

            await Task.Delay(6000); // let the app finish booting first

            if (!http.DefaultRequestHeaders.UserAgent.TryParseAdd("holdonquietly-updater"))
                http.DefaultRequestHeaders.UserAgent.Clear();
            http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");

            string json = await http.GetStringAsync("https://api.github.com/repos/" + REPO + "/releases/latest");
            var root = JsonDocument.Parse(json).RootElement;

            Version remote = ParseVer(root.TryGetProperty("tag_name", out var t) ? t.GetString() : null);
            if (remote == null || remote <= cur) return;

            // Find the .exe asset on the release.
            string url = null;
            if (root.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array)
            {
                foreach (var a in assets.EnumerateArray())
                {
                    string n = a.TryGetProperty("name", out var nm) ? nm.GetString() : null;
                    if (n != null && n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                    {
                        url = a.TryGetProperty("browser_download_url", out var du) ? du.GetString() : null;
                        break;
                    }
                }
            }
            if (string.IsNullOrEmpty(url)) return;

            // Download the new exe to a temp file, then move into place beside us.
            byte[] bytes = await http.GetByteArrayAsync(url);
            if (bytes == null || bytes.Length < 1_000_000) return; // sanity: a real exe is big
            string tmp = Path.Combine(exeDir, NEW_EXE + ".part");
            File.WriteAllBytes(tmp, bytes);
            string newPath = Path.Combine(exeDir, NEW_EXE);
            if (File.Exists(newPath)) File.Delete(newPath);
            File.Move(tmp, newPath);

            WriteSwapCmd();
            pending = true;

            RunJs?.Invoke("window.__hoqUpdate && window.__hoqUpdate('ready'," + JsStr(VerStr(remote)) + ")");
        }
        catch { /* offline / rate-limited / no release yet — silently skip */ }
    }

    // Launch the swap cmd (waits for exit, replaces exe, relaunches). Called by
    // Program on a real quit, or when the user clicks "restart to finish".
    public static void LaunchSwap()
    {
        if (!pending) return;
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"" + Path.Combine(exeDir, CMD) + "\"",
                WorkingDirectory = exeDir,
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            System.Diagnostics.Process.Start(psi);
        }
        catch { }
    }

    static void WriteSwapCmd()
    {
        // Waits for the running exe to exit (its file lock releases), swaps in the
        // new one, relaunches, then deletes itself.
        string c =
            "@echo off\r\n" +
            "cd /d \"%~dp0\"\r\n" +
            ":wait\r\n" +
            "tasklist /fi \"imagename eq " + EXE + "\" | find /i \"" + EXE + "\" >nul\r\n" +
            "if not errorlevel 1 (\r\n" +
            "  ping -n 2 127.0.0.1 >nul\r\n" +
            "  goto wait\r\n" +
            ")\r\n" +
            "move /y \"" + NEW_EXE + "\" \"" + EXE + "\" >nul\r\n" +
            "start \"\" \"" + EXE + "\"\r\n" +
            "del \"%~f0\"\r\n";
        File.WriteAllText(Path.Combine(exeDir, CMD), c);
    }

    static Version ParseVer(string tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        tag = tag.Trim();
        if (tag.StartsWith("v") || tag.StartsWith("V")) tag = tag.Substring(1);
        return Version.TryParse(tag, out var v) ? v : null;
    }

    static string VerStr(Version v)
    {
        // Trim trailing .0 groups so 1.2.0.0 -> "1.2".
        if (v.Revision > 0) return v.ToString(4);
        if (v.Build > 0) return v.ToString(3);
        return v.ToString(2);
    }

    static string JsStr(string s) => "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
