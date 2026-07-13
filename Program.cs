using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Collections.Generic;
using System.Net.Http;
using System.Windows;
using System.Windows.Shell;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Web.WebView2.Core;

class Program
{
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll")] static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);
    const int WM_NCLBUTTONDOWN = 0xA1;
    const int HTCAPTION = 0x2;

    static System.Windows.Forms.NotifyIcon tray;
    static bool realQuit = false;

    const string CHROME_UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    // Ad/tracker hosts to block at the network layer (NOT adswizz — that gates
    // monetized track playback; the in-page killer mutes those ads instead).
    static readonly string[] AD_HOSTS = {
        "doubleclick.net", "googlesyndication.com", "googleadservices.com",
        "googletagservices.com", "adtrafficquality.google", "google-analytics.com",
        "googletagmanager.com", "scorecardresearch.com", "quantserve.com", "moatads.com",
        "adnxs.com", "rubiconproject.com", "pubmatic.com", "criteo.com",
        "amazon-adsystem.com", "adsafeprotected.com", "360yield.com", "demdex.net",
        "sail-horizon.com", "taboola.com", "outbrain.com"
    };

    static Window win;
    static WebView2 wv;
    static CoreWebView2Environment env;   // shared so OAuth popups use the same cookie store
    static bool maxed = false;
    static Rect restoreBounds;
    static readonly string LogFile = Path.Combine(Path.GetTempPath(), "scwv2.log");
    static void Log(string s) { try { File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + s + "\n"); } catch { } }

    [STAThread]
    static void Main()
    {
        // Give the process a stable app identity so Windows' "now playing" flyout
        // shows the app instead of "Unknown app".
        try { SetCurrentProcessExplicitAppUserModelID("holdonquietly.desktop.app"); } catch { }
        // Register a Start-Menu shortcut with the same id so Windows resolves the
        // media flyout to "holdonquietly" + our icon instead of "Unknown app".
        try { ShortcutHelper.EnsureShortcut("holdonquietly.desktop.app", "holdonquietly", System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName); } catch { }

        var app = new Application();
        win = new Window
        {
            Title = "holdonquietly",
            Width = 1280,
            Height = 820,
            WindowStyle = WindowStyle.None,
            Background = System.Windows.Media.Brushes.Black,
        };
        try
        {
            string ico = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "logo.png");
            if (File.Exists(ico)) win.Icon = BitmapFrame.Create(new Uri(ico), BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        }
        catch { }
        WindowChrome.SetWindowChrome(win, new WindowChrome
        {
            CaptionHeight = 0,                          // our injected titlebar handles dragging
            ResizeBorderThickness = new Thickness(6),   // still resizable from edges
            GlassFrameThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0),
        });

        wv = new WebView2();
        win.Content = wv;
        win.Loaded += async (s, e) => await Init();

        // Tray icon: closing the window hides to tray instead of quitting.
        SetupTray();
        win.Closing += (s, e) =>
        {
            if (!realQuit) { e.Cancel = true; win.Hide(); }
        };

        win.Show();
        app.Run();
    }

    static void SetupTray()
    {
        try
        {
            tray = new System.Windows.Forms.NotifyIcon { Text = "holdonquietly", Visible = true };
            try { tray.Icon = System.Drawing.Icon.ExtractAssociatedIcon(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName); } catch { }
            tray.DoubleClick += (s, e) => ShowFromTray();
            var menu = new System.Windows.Forms.ContextMenuStrip();
            menu.Items.Add("Show holdonquietly", null, (s, e) => ShowFromTray());
            menu.Items.Add("Quit", null, (s, e) => { realQuit = true; try { Updater.LaunchSwap(); } catch { } try { tray.Visible = false; tray.Dispose(); } catch { } win.Close(); });
            tray.ContextMenuStrip = menu;
        }
        catch { }
    }

    static void ShowFromTray()
    {
        try { win.Show(); win.WindowState = WindowState.Normal; win.Activate(); } catch { }
    }

    // Read an embedded resource as text (null if missing). Used so a lone .exe
    // carries preload.js without needing loose files beside it.
    static string EmbeddedText(string name)
    {
        try
        {
            using var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (s == null) return null;
            using var r = new StreamReader(s);
            return r.ReadToEnd();
        }
        catch { return null; }
    }
    static void ExtractResource(string name, string dest)
    {
        using var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
        if (s == null) return;
        using var fs = File.Create(dest);
        s.CopyTo(fs);
    }

    static async Task Init()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string userData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SoundCloudApp");

        // A LONE single-file exe has no loose files beside it — pull logo.png out
        // of the embedded resources into a writable folder so the virtual host can
        // still serve it. (preload.js is read straight from the resource below.)
        string assetDir = baseDir;
        if (!File.Exists(Path.Combine(assetDir, "logo.png")))
        {
            assetDir = Path.Combine(userData, "assets");
            try { Directory.CreateDirectory(assetDir); ExtractResource("logo.png", Path.Combine(assetDir, "logo.png")); } catch { }
        }

        var opts = new CoreWebView2EnvironmentOptions { AreBrowserExtensionsEnabled = true };
        // Scrollbars are fully custom-styled in preload.js (::-webkit-scrollbar:
        // no arrow buttons, transparent track, accent-gradient thumb that shows on
        // hover). We deliberately DON'T enable the Win overlay scrollbar here — its
        // msOverlayScrollbarWinStyle drew the ugly up/down arrow buttons.
        env = await CoreWebView2Environment.CreateAsync(null, userData, opts);
        await wv.EnsureCoreWebView2Async(env);
        var core = wv.CoreWebView2;

        core.Settings.UserAgent = CHROME_UA;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false; // no browser Save-as/Print/Inspect menu
        core.Settings.AreDevToolsEnabled = true; // real inspector (opened from our context menu / F12)
        try { wv.DefaultBackgroundColor = System.Drawing.Color.FromArgb(11, 11, 12); } catch { }

        // Serve the app folder to the page so the injected CSS can load logo.png.
        try
        {
            core.SetVirtualHostNameToFolderMapping("holdonquietly.app", assetDir,
                CoreWebView2HostResourceAccessKind.Allow);
        }
        catch { }

        // Inject all our page-side features (ad-skip, themes, clutter removal, titlebar).
        File.WriteAllText(LogFile, "init " + DateTime.Now + "\n");
        try
        {
            string preload = EmbeddedText("preload.js");
            if (string.IsNullOrEmpty(preload)) preload = File.ReadAllText(Path.Combine(baseDir, "preload.js"));
            Log("preload read: " + preload.Length + " chars (embedded=" + (EmbeddedText("preload.js") != null) + ")");
            await core.AddScriptToExecuteOnDocumentCreatedAsync(preload);
            Log("preload injected OK");
        }
        catch (Exception ex) { Log("preload FAIL: " + ex.Message); }

        // Network ad/tracker blocking.
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (s, e) =>
        {
            try
            {
                string u = e.Request.Uri;
                foreach (var h in AD_HOSTS)
                {
                    if (u.IndexOf(h, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Blocked", "");
                        return;
                    }
                }
            }
            catch { }
        };

        // Window-control messages from the injected titlebar.
        core.WebMessageReceived += (s, e) =>
        {
            string m = e.TryGetWebMessageAsString();
            if (m != null && m.StartsWith("DBG")) Log(m);
            OnMessage(m);
        };

        // window.open / OAuth sign-in popups (Google, Facebook, Apple) must open
        // IN-APP in a WebView2 that shares this cookie store — otherwise the login
        // can't complete. (Genuinely external links go out via the "open:" message.)
        core.NewWindowRequested += async (s, e) =>
        {
            e.Handled = true;
            var deferral = e.GetDeferral();
            try
            {
                var popup = new Window
                {
                    Title = "holdonquietly",
                    Width = 500,
                    Height = 660,
                    Owner = win,
                    WindowStartupLocation = WindowStartupLocation.CenterOwner,
                    Background = System.Windows.Media.Brushes.Black,
                };
                var pwv = new WebView2();
                popup.Content = pwv;
                popup.Show();
                await pwv.EnsureCoreWebView2Async(env); // same env => shared cookies/session
                pwv.CoreWebView2.Settings.UserAgent = CHROME_UA;
                pwv.CoreWebView2.WindowCloseRequested += (a, b) => { try { popup.Close(); } catch { } };
                e.NewWindow = pwv.CoreWebView2;
            }
            catch { }
            finally { deferral.Complete(); }
        };

        // Keep the window title fixed.
        core.DocumentTitleChanged += (s, e) => win.Title = "holdonquietly";

        // Load the ad-blocker extension (best effort).
        try
        {
            string ext = Path.Combine(baseDir, "extensions", "holdonquietly-blocker");
            if (Directory.Exists(ext)) await core.Profile.AddBrowserExtensionAsync(ext);
        }
        catch { }

        core.Navigate("https://soundcloud.com/discover");
        _ = DiscordRpc.Connect();   // Rich Presence (best effort; needs Discord running)
        _ = DiscordRpc.KeepAlive(); // reconnect if Discord starts later / pipe drops
        _ = FriendsLoop();          // poll the shared friends backend
        LastFm.Load(userData);      // restore a saved Last.fm session if there is one
        LastFm.OnStatus = (connected, u) => win.Dispatcher.InvokeAsync(() =>
        {
            try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqLastfm && window.__hoqLastfm(" + (connected ? "true" : "false") + ",\"" + (u ?? "").Replace("\\", "").Replace("\"", "") + "\")"); } catch { }
        });

        // Silent auto-update: check GitHub Releases in the background, stage a swap
        // if newer. RunJs lets the updater show a page toast; ApplyAndRestart does a
        // clean quit that lets the swap cmd replace the exe + relaunch.
        Updater.RunJs = js => win.Dispatcher.InvokeAsync(() => { try { _ = wv.CoreWebView2.ExecuteScriptAsync(js); } catch { } });
        Updater.ApplyAndRestart = () => win.Dispatcher.InvokeAsync(() =>
        {
            realQuit = true;
            Updater.LaunchSwap();
            try { tray.Visible = false; tray.Dispose(); } catch { }
            win.Close();
        });
        Updater.Start(userData);
    }

    const int WM_SYSCOMMAND = 0x0112;
    const int SC_SIZE = 0xF000;
    // WMSZ_* direction codes for SC_SIZE (reliable resize on frameless windows).
    static readonly System.Collections.Generic.Dictionary<string, int> SZ = new()
    {
        { "left", 1 }, { "right", 2 }, { "top", 3 }, { "topleft", 4 },
        { "topright", 5 }, { "bottom", 6 }, { "bottomleft", 7 }, { "bottomright", 8 }
    };

    static readonly HttpClient http = new HttpClient();
    const string BACKEND = "http://155.138.222.253:8790";

    static string Prop(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
    static int PropI(JsonElement e, string k) => e.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
    static bool PropB(JsonElement e, string k) => e.TryGetProperty(k, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) && v.GetBoolean();

    // POST our now-playing to the shared friends backend (from the host = no CORS/mixed-content).
    static async Task PostPresence(string id, string name, string sc, string title, string artist, string cover)
    {
        if (string.IsNullOrEmpty(id)) return;
        try
        {
            string payload = JsonSerializer.Serialize(new { id, name, sc, title, artist, cover });
            await http.PostAsync(BACKEND + "/presence", new StringContent(payload, Encoding.UTF8, "application/json"));
        }
        catch { }
    }

    // Post the current track to a Discord webhook. The URL is read from a LOCAL
    // config file (%LocalAppData%\SoundCloudApp\webhook.txt) — never embedded in
    // the app/repo — so the public build can't be abused to spam a channel. The
    // POST is host-side because Discord webhook endpoints don't send CORS headers.
    static string WebhookPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SoundCloudApp", "webhook.txt");

    static async Task PostWebhook(string json)
    {
        try
        {
            string wh = File.Exists(WebhookPath()) ? File.ReadAllText(WebhookPath()).Trim() : "";
            if (string.IsNullOrEmpty(wh) || !wh.StartsWith("http")) return;

            var r = JsonDocument.Parse(json).RootElement;
            string title = Prop(r, "title"), artist = Prop(r, "artist"), cover = Prop(r, "cover"),
                   url = Prop(r, "url"), name = Prop(r, "name"), avatar = Prop(r, "avatar"), length = Prop(r, "length");
            if (string.IsNullOrEmpty(title)) return;

            int color = 0xff5500;
            if (r.TryGetProperty("color", out var cc) && cc.ValueKind == JsonValueKind.Number) color = cc.GetInt32();

            var author = new Dictionary<string, object>
            {
                ["name"] = string.IsNullOrEmpty(name) ? "Now playing" : (name + " shared a track"),
            };
            if (!string.IsNullOrEmpty(avatar)) author["icon_url"] = avatar;

            var embed = new Dictionary<string, object>
            {
                ["author"] = author,
                ["title"] = title,
                ["color"] = color,
                ["timestamp"] = DateTime.UtcNow.ToString("o"),
                ["footer"] = new Dictionary<string, object> { ["text"] = "via holdonquietly" },
            };
            if (!string.IsNullOrEmpty(url)) embed["url"] = url;
            if (!string.IsNullOrEmpty(artist)) embed["description"] = "by **" + artist + "**";
            if (!string.IsNullOrEmpty(cover)) embed["thumbnail"] = new Dictionary<string, object> { ["url"] = cover };

            var fields = new List<object>();
            if (!string.IsNullOrEmpty(length))
                fields.Add(new Dictionary<string, object> { ["name"] = "Length", ["value"] = length, ["inline"] = true });
            if (!string.IsNullOrEmpty(url))
                fields.Add(new Dictionary<string, object> { ["name"] = "Listen", ["value"] = "[Open in SoundCloud](" + url + ")", ["inline"] = true });
            if (fields.Count > 0) embed["fields"] = fields;

            var payload = new Dictionary<string, object>
            {
                ["username"] = string.IsNullOrEmpty(name) ? "holdonquietly" : name,
                ["embeds"] = new[] { embed },
            };
            if (!string.IsNullOrEmpty(avatar)) payload["avatar_url"] = avatar;
            await http.PostAsync(wh, new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
        }
        catch { }
    }

    // Poll everyone's presence and hand it to the page to render the friends feed.
    static async Task FriendsLoop()
    {
        while (true)
        {
            try
            {
                string json = await http.GetStringAsync(BACKEND + "/friends");
                await win.Dispatcher.InvokeAsync(() =>
                {
                    try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqFriends && window.__hoqFriends(" + json + ")"); } catch { }
                });
            }
            catch { }
            await Task.Delay(15000);
        }
    }

    // Fetch the Discord server widget (name + online count) from the host (no CORS)
    // and hand it to the page to render the in-app server embed. Needs "Enable Server
    // Widget" on in the Discord server settings, else Discord returns 403 -> hide it.
    static async Task DcWidget()
    {
        string js = "window.__hoqDcWidget && window.__hoqDcWidget(null)";
        try
        {
            string json = await http.GetStringAsync("https://discord.com/api/guilds/795316631655546900/widget.json");
            if (!string.IsNullOrWhiteSpace(json) && json.TrimStart().StartsWith("{"))
                js = "window.__hoqDcWidget && window.__hoqDcWidget(" + json + ")";
        }
        catch { }
        await win.Dispatcher.InvokeAsync(() => { try { _ = wv.CoreWebView2.ExecuteScriptAsync(js); } catch { } });
    }

    // Right-click "Save image": download the bytes here (no page CORS), then let
    // the user pick where to save via a standard dialog.
    static async Task SaveImage(string url)
    {
        try
        {
            byte[] bytes = await http.GetByteArrayAsync(url);
            await win.Dispatcher.InvokeAsync(() =>
            {
                string name = "image.jpg";
                try { var n = System.IO.Path.GetFileName(new Uri(url).LocalPath); if (!string.IsNullOrWhiteSpace(n)) name = n; } catch { }
                if (!name.Contains(".")) name += ".jpg";
                var dlg = new Microsoft.Win32.SaveFileDialog
                {
                    FileName = name,
                    Filter = "Images|*.jpg;*.jpeg;*.png;*.gif;*.webp|All files|*.*",
                    InitialDirectory = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
                };
                try { if (dlg.ShowDialog() == true) File.WriteAllBytes(dlg.FileName, bytes); } catch { }
            });
        }
        catch { }
    }

    // ===== Multi-account: save/restore each account's SoundCloud session cookies
    // so you can switch accounts on the same app instance (Instagram-style). =====
    static string AcctDir()
    {
        string d = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SoundCloudApp", "accounts");
        Directory.CreateDirectory(d);
        return d;
    }
    static string AcctFile(string name)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
        return Path.Combine(AcctDir(), name + ".json");
    }

    static async Task AcctSave(string name)
    {
        try
        {
            var cm = wv.CoreWebView2.CookieManager;
            var cookies = await cm.GetCookiesAsync("https://soundcloud.com");
            var list = new List<object>();
            foreach (var c in cookies)
                list.Add(new { c.Name, c.Value, c.Domain, c.Path, Secure = c.IsSecure, Http = c.IsHttpOnly, Session = c.IsSession, c.Expires, Same = (int)c.SameSite });
            File.WriteAllText(AcctFile(name), JsonSerializer.Serialize(list));
        }
        catch { }
        AcctList();
    }

    static async Task AcctSwitch(string name)
    {
        try
        {
            string f = AcctFile(name);
            if (!File.Exists(f)) return;
            var cm = wv.CoreWebView2.CookieManager;
            cm.DeleteAllCookies();
            var arr = JsonDocument.Parse(File.ReadAllText(f)).RootElement;
            foreach (var c in arr.EnumerateArray())
            {
                var ck = cm.CreateCookie(Prop(c, "Name"), Prop(c, "Value"), Prop(c, "Domain"), Prop(c, "Path"));
                ck.IsSecure = PropB(c, "Secure");
                ck.IsHttpOnly = PropB(c, "Http");
                try { ck.SameSite = (CoreWebView2CookieSameSiteKind)PropI(c, "Same"); } catch { }
                if (!PropB(c, "Session") && c.TryGetProperty("Expires", out var e) && e.ValueKind == JsonValueKind.String)
                    try { ck.Expires = e.GetDateTime(); } catch { }
                cm.AddOrUpdateCookie(ck);
            }
            wv.CoreWebView2.Navigate("https://soundcloud.com/discover");
        }
        catch { }
    }

    static void AcctRemove(string name) { try { File.Delete(AcctFile(name)); } catch { } AcctList(); }

    static void AcctNew()
    {
        try { wv.CoreWebView2.CookieManager.DeleteAllCookies(); wv.CoreWebView2.Navigate("https://soundcloud.com/signin"); } catch { }
    }

    static void AcctList()
    {
        try
        {
            var names = Directory.GetFiles(AcctDir(), "*.json").Select(p => Path.GetFileNameWithoutExtension(p)).ToArray();
            string json = JsonSerializer.Serialize(names);
            win.Dispatcher.InvokeAsync(() => { try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqAccounts && window.__hoqAccounts(" + json + ")"); } catch { } });
        }
        catch { }
    }

    // "Match song cover": JS couldn't read the artwork pixels (CORS), so it sent
    // us the URL — download it (no CORS here), find 2 dominant colors, send back.
    static async Task HandleCover(string url)
    {
        try
        {
            byte[] bytes = await http.GetByteArrayAsync(url);
            var (c1, c2) = DominantColors(bytes);
            if (c1 != null)
                await wv.CoreWebView2.ExecuteScriptAsync(
                    "window.__scCoverColors && window.__scCoverColors('" + c1 + "','" + c2 + "')");
        }
        catch { }
    }

    static (string, string) DominantColors(byte[] bytes)
    {
        try
        {
            var frame = BitmapDecoder.Create(new MemoryStream(bytes),
                BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
            const int S = 28;
            var scaled = new TransformedBitmap(frame,
                new ScaleTransform((double)S / frame.PixelWidth, (double)S / frame.PixelHeight));
            var conv = new FormatConvertedBitmap(scaled, PixelFormats.Bgra32, null, 0);
            int w = conv.PixelWidth, h = conv.PixelHeight;
            byte[] px = new byte[w * h * 4];
            conv.CopyPixels(px, w * 4, 0);

            var buckets = new Dictionary<int, int[]>(); // key -> {r,g,b,count,satSum}
            for (int i = 0; i < px.Length; i += 4)
            {
                int b = px[i], g = px[i + 1], r = px[i + 2], a = px[i + 3];
                if (a < 200) continue;
                int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
                int sat = mx - mn, light = (mx + mn) / 2;
                if (sat < 42 || light < 28 || light > 235) continue;
                int key = (r >> 5) * 64 + (g >> 5) * 8 + (b >> 5);
                if (!buckets.TryGetValue(key, out var bk)) { bk = new int[5]; buckets[key] = bk; }
                bk[0] += r; bk[1] += g; bk[2] += b; bk[3]++; bk[4] += sat;
            }
            if (buckets.Count == 0) return (null, null);
            // Average each bucket to an RGB, ordered by saturation prominence.
            var cols = buckets.Values.OrderByDescending(bk => bk[4])
                .Select(bk => new[] { bk[0] / bk[3], bk[1] / bk[3], bk[2] / bk[3] }).ToList();
            var top = cols[0];
            int[] b2 = null;
            foreach (var c in cols.Skip(1))
                if (Math.Abs(c[0] - top[0]) + Math.Abs(c[1] - top[1]) + Math.Abs(c[2] - top[2]) > 90) { b2 = c; break; }
            // No sufficiently different second color -> use a darker shade of the first.
            if (b2 == null) b2 = new[] { (int)(top[0] * 0.5), (int)(top[1] * 0.5), (int)(top[2] * 0.5) };
            int Cl(int x) => x < 0 ? 0 : x > 255 ? 255 : x;
            string Hex(int[] c) => "#" + Cl(c[0]).ToString("x2") + Cl(c[1]).ToString("x2") + Cl(c[2]).ToString("x2");
            return (Hex(top), Hex(b2));
        }
        catch { return (null, null); }
    }

    static async void OnMessage(string m)
    {
        if (m != null && m.StartsWith("cover:")) { await HandleCover(m.Substring(6)); return; }
        if (m != null && m.StartsWith("open:"))
        {
            try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(m.Substring(5)) { UseShellExecute = true }); } catch { }
            return;
        }
        if (m != null && m.StartsWith("saveimg:")) { await SaveImage(m.Substring(8)); return; }
        if (m != null && m.StartsWith("webhook:")) { await PostWebhook(m.Substring(8)); return; }
        if (m != null && m.StartsWith("acct:save:")) { await AcctSave(m.Substring(10)); return; }
        if (m != null && m.StartsWith("acct:switch:")) { await AcctSwitch(m.Substring(12)); return; }
        if (m != null && m.StartsWith("acct:remove:")) { AcctRemove(m.Substring(12)); return; }
        if (m == "acct:list") { AcctList(); return; }
        if (m == "acct:new") { AcctNew(); return; }
        if (m != null && m.StartsWith("rpc:"))
        {
            try
            {
                var r = JsonDocument.Parse(m.Substring(4)).RootElement;
                string title = Prop(r, "title"), artist = Prop(r, "artist"), cover = Prop(r, "cover");
                if (string.IsNullOrEmpty(title)) DiscordRpc.Clear();
                else DiscordRpc.SetActivity(title, artist, cover, PropI(r, "pos"), PropI(r, "dur"), PropB(r, "paused"));
                _ = PostPresence(Prop(r, "id"), Prop(r, "name"), Prop(r, "sc"), title, artist, cover);
                LastFm.Track(title, artist, PropI(r, "pos"), PropI(r, "dur"), PropB(r, "paused"));
            }
            catch { }
            return;
        }
        if (m == "rpcclear") { DiscordRpc.Clear(); return; }
        if (m == "lastfm:connect") { _ = LastFm.Connect(); return; }
        if (m == "lastfm:disconnect") { LastFm.Disconnect(); return; }
        if (m == "lastfm:status") { LastFm.Status(); return; }
        if (m == "dcwidget") { _ = DcWidget(); return; }
        if (m == "update:apply") { Updater.ApplyAndRestart?.Invoke(); return; }
        if (m != null && m.StartsWith("win:resize:"))
        {
            if (!maxed && SZ.TryGetValue(m.Substring("win:resize:".Length), out int wmsz))
            {
                ReleaseCapture();
                SendMessage(new WindowInteropHelper(win).Handle, WM_SYSCOMMAND, (IntPtr)(SC_SIZE + wmsz), IntPtr.Zero);
            }
            return;
        }
        switch (m)
        {
            case "win:minimize":
                win.WindowState = WindowState.Minimized;
                break;
            case "win:maximize":
                ToggleMaximize();
                break;
            case "win:close":
                win.Close();
                break;
            case "win:drag":
                if (maxed) ToggleMaximize();
                ReleaseCapture();
                SendMessage(new WindowInteropHelper(win).Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                break;
            case "app:reset":
                try { await wv.CoreWebView2.Profile.ClearBrowsingDataAsync(); } catch { }
                wv.CoreWebView2.Navigate("https://soundcloud.com/discover");
                break;
            case "opendevtools":
                try { wv.CoreWebView2.OpenDevToolsWindow(); } catch { }
                break;
        }
    }

    // Maximize to the working area (so it never covers the taskbar), toggle back.
    static void ToggleMaximize()
    {
        if (!maxed)
        {
            restoreBounds = new Rect(win.Left, win.Top, win.Width, win.Height);
            var wa = SystemParameters.WorkArea;
            win.Left = wa.Left; win.Top = wa.Top; win.Width = wa.Width; win.Height = wa.Height;
            maxed = true;
        }
        else
        {
            win.Left = restoreBounds.X; win.Top = restoreBounds.Y;
            win.Width = restoreBounds.Width; win.Height = restoreBounds.Height;
            maxed = false;
        }
    }
}

// Minimal Discord Rich Presence over the local Discord IPC pipe. Uses only the
// PUBLIC Client ID — no token/secret. Shows "Listening to holdonquietly · <song>".
static class DiscordRpc
{
    const string CLIENT_ID = "1523891530417442916";
    static NamedPipeClientStream pipe;
    static volatile bool ready = false;
    static string lastActivity; // re-pushed after a reconnect so presence returns

    public static async Task Connect()
    {
        if (ready) return;
        for (int i = 0; i < 10; i++)
        {
            try
            {
                var p = new NamedPipeClientStream(".", "discord-ipc-" + i, PipeDirection.InOut, PipeOptions.Asynchronous);
                await p.ConnectAsync(1500);
                pipe = p;
                Send(0, "{\"v\":1,\"client_id\":\"" + CLIENT_ID + "\"}"); // handshake
                ready = true;
                _ = ReadLoop();
                if (lastActivity != null) Send(1, lastActivity); // restore presence
                return;
            }
            catch { }
        }
    }

    // Discord frequently isn't running (or the pipe drops) when the app starts;
    // keep trying so presence shows up whenever Discord becomes available.
    public static async Task KeepAlive()
    {
        while (true)
        {
            await Task.Delay(8000);
            if (!ready || pipe == null || !pipe.IsConnected) { ready = false; await Connect(); }
        }
    }

    public static void SetActivity(string title, string artist, string cover = "", int pos = 0, int dur = 0, bool paused = true)
    {
        if (!ready) return;
        // large_image: the song cover URL if we have one, else the "logo" asset.
        string large = string.IsNullOrEmpty(cover) ? "\"logo\"" : "\"" + Esc(cover) + "\"";
        // Discord rejects empty fields, so only include state when there's an artist.
        string stateField = string.IsNullOrWhiteSpace(artist) ? "" : ",\"state\":\"" + Esc(artist) + "\"";
        // Real song progress: only while PLAYING and we know the duration. Paused = no timer.
        string ts = "";
        if (!paused && dur > 0 && pos >= 0 && pos <= dur)
        {
            long nowS = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            ts = ",\"timestamps\":{\"start\":" + (nowS - pos) + ",\"end\":" + (nowS - pos + dur) + "}";
        }
        string act = "{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"" + Guid.NewGuid().ToString() +
            "\",\"args\":{\"pid\":" + Environment.ProcessId +
            ",\"activity\":{\"type\":2,\"details\":\"" + Esc(title) + "\"" + stateField + ts +
            ",\"assets\":{\"large_image\":" + large + ",\"large_text\":\"holdonquietly\"," +
            "\"small_image\":\"logo\",\"small_text\":\"holdonquietly\"}}}}";
        lastActivity = act;
        Send(1, act);
    }

    public static void Clear()
    {
        lastActivity = null;
        if (!ready) return;
        Send(1, "{\"cmd\":\"SET_ACTIVITY\",\"nonce\":\"" + Guid.NewGuid().ToString() +
            "\",\"args\":{\"pid\":" + Environment.ProcessId + "}}");
    }

    static void Send(int op, string json)
    {
        if (pipe == null || !pipe.IsConnected) return;
        try
        {
            byte[] data = Encoding.UTF8.GetBytes(json);
            byte[] buf = new byte[8 + data.Length];
            BitConverter.GetBytes(op).CopyTo(buf, 0);
            BitConverter.GetBytes(data.Length).CopyTo(buf, 4);
            data.CopyTo(buf, 8);
            pipe.Write(buf, 0, buf.Length);
            pipe.Flush();
        }
        catch { ready = false; }
    }

    static async Task ReadLoop()
    {
        byte[] head = new byte[8];
        while (pipe != null && pipe.IsConnected)
        {
            try
            {
                int n = await pipe.ReadAsync(head, 0, 8);
                if (n < 8) break;
                int len = BitConverter.ToInt32(head, 4);
                if (len > 0) { byte[] payload = new byte[len]; int r = 0; while (r < len) { int k = await pipe.ReadAsync(payload, r, len - r); if (k <= 0) break; r += k; } }
            }
            catch { break; }
        }
        ready = false;
    }

    static string Esc(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", " ");
}
