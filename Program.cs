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
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    const int WM_NCLBUTTONDOWN = 0xA1;
    const int HTCAPTION = 0x2;
    // Global media keys: registered system-wide so play/pause/next/prev work while a
    // game or any other app is focused. Handled in HotkeyHook -> window.__hoqMedia.
    const int WM_HOTKEY = 0x0312;
    const uint VK_MEDIA_NEXT_TRACK = 0xB0, VK_MEDIA_PREV_TRACK = 0xB1, VK_MEDIA_STOP = 0xB2, VK_MEDIA_PLAY_PAUSE = 0xB3;
    const int HK_PLAYPAUSE = 0xB001, HK_NEXT = 0xB002, HK_PREV = 0xB003, HK_STOP = 0xB004;

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
    internal static void Log(string s) { try { File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + s + "\n"); } catch { } }

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
        // A second instance can't share the WebView2 user-data folder (it's locked
        // by the first). Set HOQ_DATADIR to give a test instance its own folder so
        // it runs alongside the main one instead of forcing a restart.
        string userData = Environment.GetEnvironmentVariable("HOQ_DATADIR");
        if (string.IsNullOrWhiteSpace(userData))
            userData = Path.Combine(
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

        // The header "play SoundCloud out of <device>" picker needs enumerateDevices()
        // to return real device names + ids, and setSinkId() to a specific device to be
        // allowed — both of which Chromium only unlocks after an audio-input permission
        // grant. Auto-grant Microphone so the user isn't hit with a "SoundCloud wants
        // your microphone" prompt on a music app. It is used ONLY to unlock the output
        // list: preload opens a stream and stops it in the same breath (setupOutputPicker),
        // never reading any audio. Nothing else changes permission behavior.
        try
        {
            core.PermissionRequested += (s, e) =>
            {
                try
                {
                    if (e.PermissionKind == CoreWebView2PermissionKind.Microphone)
                        e.State = CoreWebView2PermissionState.Allow;
                }
                catch { }
            };
        }
        catch { }

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

        try { SetupMediaKeys(); } catch (Exception ex) { Log("mediakeys FAIL: " + ex.Message); }

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

        // window.open / target="_blank".
        //   - OAuth sign-in popups (Google, Facebook, Apple, SoundCloud's own
        //     secure host) MUST open in-app in a WebView2 that shares this cookie
        //     store, or the login can't complete.
        //   - Everything else (Artist Studio, "Get unlimited uploads", Insights
        //     links, etc.) was also opening as a stray popup window. Those should
        //     just navigate the MAIN window instead.
        core.NewWindowRequested += async (s, e) =>
        {
            e.Handled = true;

            bool isAuth = false;
            try
            {
                var host = new Uri(e.Uri).Host.ToLowerInvariant();
                isAuth = host.Contains("accounts.google") || host.Contains("appleid")
                      || host.Contains("facebook.com") || host.Contains("secure.soundcloud")
                      || host.Contains("api-auth.soundcloud") || host.Contains("oauth");
            }
            catch { }

            // Non-auth link: navigate the main window, no popup.
            if (!isAuth)
            {
                try { core.Navigate(e.Uri); } catch { }
                return;
            }

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
        _ = ReadWebhook();          // warm the cache, so a later failed read still has a URL
        _ = FeedLoop();             // poll the community feed
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
    static bool PropBool(JsonElement e, string k, bool def) =>
        e.TryGetProperty(k, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : def;

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

    // Remembered after the first good read. A momentary failure to read the file
    // (AV scan, another process holding it, transient IO) used to drop the request
    // silently and look exactly like "it worked for a second, then stopped".
    static string _webhookCache = "";

    static async Task<string> ReadWebhook()
    {
        // Every failed attempt records WHICH check failed. The old version only
        // logged exceptions, so "file not found" / "empty" / "not a URL" all
        // collapsed into one "not configured" line — and on 2026-09-13 that line
        // fired while the file sat there valid, with nothing to say why.
        string why = "";
        for (int attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                string path = WebhookPath();
                if (!File.Exists(path)) why = "File.Exists returned false";
                else
                {
                    string t = File.ReadAllText(path).Trim();
                    if (t.StartsWith("http", StringComparison.Ordinal)) { _webhookCache = t; return t; }
                    why = t.Length == 0 ? "file is empty" : "file does not start with http (" + t.Length + " chars)";
                }
            }
            catch (Exception ex) { why = ex.GetType().Name + ": " + ex.Message; }
            Log("webhook read attempt " + attempt + " failed: " + why);
            if (attempt < 3) await Task.Delay(300 * attempt);
        }
        if (!string.IsNullOrEmpty(_webhookCache))
        {
            Log("webhook: file unreadable right now, using the URL cached this session");
            return _webhookCache;
        }
        return "";
    }

    // Tell the page how a play request went. The button shows "Queued" the
    // moment it's clicked, so without this a request that never reached
    // Discord looked like it worked, and the one-per-track lock blocked a retry.
    static void PlayResult(bool ok, string reason)
    {
        string r = (reason ?? "").Replace("\\", "").Replace("\"", "'").Replace("\r", " ").Replace("\n", " ");
        win?.Dispatcher.InvokeAsync(() =>
        {
            try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqPlayResult && window.__hoqPlayResult(" + (ok ? "true" : "false") + ",\"" + r + "\")"); } catch { }
        });
    }

    static async Task PostWebhook(string json, bool play = false)
    {
        try
        {
            string wh = await ReadWebhook();
            if (string.IsNullOrEmpty(wh) || !wh.StartsWith("http"))
            {
                Log((play ? "playreq" : "share") + " ABORT: webhook not configured at " + WebhookPath());
                if (play) PlayResult(false, "no webhook set up");
                return;
            }

            var r = JsonDocument.Parse(json).RootElement;
            string title = Prop(r, "title"), artist = Prop(r, "artist"), cover = Prop(r, "cover"),
                   url = Prop(r, "url"), name = Prop(r, "name"), avatar = Prop(r, "avatar"), length = Prop(r, "length");
            if (string.IsNullOrEmpty(title))
            {
                Log((play ? "playreq" : "share") + " ABORT: payload had no title");
                if (play) PlayResult(false, "no track info");
                return;
            }
            Log((play ? "playreq" : "share") + " -> title=\"" + title + "\" url=" + (string.IsNullOrEmpty(url) ? "(none)" : url));

            int color = 0xff5500;
            if (r.TryGetProperty("color", out var cc) && cc.ValueKind == JsonValueKind.Number) color = cc.GetInt32();

            // ---- Components V2 card -----------------------------------------------
            // A plain channel webhook CAN post a V2 card — but only with the
            // ?with_components=true query flag below; without it Discord strips the
            // components and the post fails as an empty message (50006). A V2 message
            // carries no embeds, so the marker the bot keys off lives in the footer
            // text ("Play in Discord" / "via holdonquietly"), and the track link is
            // the markdown link in the title line.
            string authorName = string.IsNullOrEmpty(name)
                ? (play ? "Play request" : "Now playing")
                : (name + (play ? " wants to play this" : " shared a track"));

            // The artist's profile is the first path segment of the track URL, so we
            // can link "by <artist>" without the page having to send a separate field.
            string artistUrl = "";
            try
            {
                if (!string.IsNullOrEmpty(url))
                {
                    var uu = new Uri(url);
                    var seg = uu.AbsolutePath.Trim('/').Split('/');
                    if (seg.Length >= 2 && seg[0].Length > 0) artistUrl = uu.GetLeftPart(UriPartial.Authority) + "/" + seg[0];
                }
            }
            catch { }

            var head = new StringBuilder();
            head.Append("-# ").Append(authorName).Append("\n### ");
            head.Append(string.IsNullOrEmpty(url) ? title : "[" + title + "](" + url + ")");
            var meta = new List<string>();
            if (!string.IsNullOrEmpty(artist))
                meta.Add(string.IsNullOrEmpty(artistUrl) ? ("by **" + artist + "**") : ("by [" + artist + "](" + artistUrl + ")"));
            if (!string.IsNullOrEmpty(length)) meta.Add(length);
            if (meta.Count > 0) head.Append("\n").Append(string.Join("  ·  ", meta));

            var headerDisplay = new Dictionary<string, object> { ["type"] = 10, ["content"] = head.ToString() };

            string marker = play ? "Play in Discord" : "via holdonquietly";
            var footerDisplay = new Dictionary<string, object>
            {
                ["type"] = 10,
                ["content"] = "-# " + marker + "  ·  <t:" + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + ":R>",
            };

            // Full-width header, then the cover art BIG (a media gallery, not the small
            // thumbnail accessory it used to be), then the footer.
            var inner = new List<object> { headerDisplay };
            if (!string.IsNullOrEmpty(cover))
                inner.Add(new Dictionary<string, object>
                {
                    ["type"] = 12, // Media Gallery — the big image slot
                    ["items"] = new object[] { new Dictionary<string, object> { ["media"] = new Dictionary<string, object> { ["url"] = cover } } },
                });
            inner.Add(footerDisplay);

            var container = new Dictionary<string, object>
            {
                ["type"] = 17,                 // Container — accent_color is the left bar
                ["accent_color"] = color,
                ["components"] = inner.ToArray(),
            };

            var payload = new Dictionary<string, object>
            {
                ["username"] = string.IsNullOrEmpty(name) ? "holdonquietly" : name,
                ["flags"] = 32768,             // IS_COMPONENTS_V2 (1 << 15)
                ["components"] = new object[] { container },
            };
            if (!string.IsNullOrEmpty(avatar)) payload["avatar_url"] = avatar;

            string postUrl = wh + (wh.Contains("?") ? "&" : "?") + "with_components=true";
            var resp = await http.PostAsync(postUrl, new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"));
            // Discord answers 204 on success; anything else (bad hook, rate limit,
            // malformed embed) used to fail completely silently.
            Log((play ? "playreq" : "share") + " <- HTTP " + (int)resp.StatusCode +
                (resp.IsSuccessStatusCode ? "" : " " + await resp.Content.ReadAsStringAsync()));
            if (play) PlayResult(resp.IsSuccessStatusCode,
                resp.IsSuccessStatusCode ? "sent to Discord" : "Discord refused it (" + (int)resp.StatusCode + ")");
        }
        catch (Exception ex)
        {
            Log((play ? "playreq" : "share") + " FAILED: " + ex.Message);
            if (play) PlayResult(false, "couldn't reach discord");
        }
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

    // Community feed: post host-side (no mixed-content), then push the fresh feed
    // straight back so the poster sees their message land immediately.
    static async Task PostFeed(string json, bool refresh)
    {
        try { await http.PostAsync(BACKEND + "/feed", new StringContent(json, Encoding.UTF8, "application/json")); }
        catch { }
        if (refresh) await PushFeed();
    }
    static async Task PushFeed()
    {
        try
        {
            string json = await http.GetStringAsync(BACKEND + "/feed");
            await win.Dispatcher.InvokeAsync(() =>
            { try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqFeed && window.__hoqFeed(" + json + ")"); } catch { } });
        }
        catch
        {
            await win.Dispatcher.InvokeAsync(() =>
            { try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqFeedOffline && window.__hoqFeedOffline()"); } catch { } });
        }
    }
    // Poll the feed and hand it to the page.
    static async Task FeedLoop()
    {
        while (true) { await PushFeed(); await Task.Delay(12000); }
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
        if (m != null && m.StartsWith("playreq:")) { await PostWebhook(m.Substring(8), true); return; }
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
                // Presence preferences from Settings → Discord Rich Presence. A page
                // that predates them sends none, which reads as the defaults.
                bool rpOn = true, rpButtons = true, rpPauseHide = true;
                string rpStatus = "artist";
                if (r.TryGetProperty("rp", out var rp) && rp.ValueKind == JsonValueKind.Object)
                {
                    rpOn = PropBool(rp, "on", true);
                    rpButtons = PropBool(rp, "buttons", true);
                    rpPauseHide = PropBool(rp, "pauseHide", true);
                    rpStatus = Prop(rp, "status") is var s && s.Length > 0 ? s : "artist";
                }
                if (string.IsNullOrEmpty(title) || !rpOn) DiscordRpc.Clear();
                else DiscordRpc.Update(new DiscordRpc.Track
                {
                    Title = title, Artist = artist, Cover = cover,
                    Url = Prop(r, "url"), ArtistUrl = Prop(r, "artistUrl"),
                    Pos = PropI(r, "pos"), Dur = PropI(r, "dur"), Paused = PropB(r, "paused"),
                    Status = rpStatus, Buttons = rpButtons, PauseHide = rpPauseHide,
                });
                Log("RP <- title=\"" + title + "\" paused=" + PropB(r, "paused") + " pos=" + PropI(r, "pos"));
                _ = PostPresence(Prop(r, "id"), Prop(r, "name"), Prop(r, "sc"), title, artist, cover);
                LastFm.Track(title, artist, PropI(r, "pos"), PropI(r, "dur"), PropB(r, "paused"));
            }
            catch { }
            return;
        }
        if (m != null && m.StartsWith("feed:post:")) { _ = PostFeed(m.Substring(10), true); return; }
        if (m == "feed:get") { _ = PushFeed(); return; }
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
            case "mini:on":
                EnterMini();
                break;
            case "mini:off":
                ExitMini();
                break;
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
            case "inspect":
                // Open real DevTools and switch it into element-inspect mode, so
                // hovering/clicking selects nodes in the Elements panel.
                try
                {
                    wv.CoreWebView2.OpenDevToolsWindow();
                    await wv.CoreWebView2.CallDevToolsProtocolMethodAsync("Overlay.enable", "{}");
                    await wv.CoreWebView2.CallDevToolsProtocolMethodAsync("Overlay.setInspectMode",
                        "{\"mode\":\"searchForNode\",\"highlightConfig\":{\"showInfo\":true,\"showStyles\":true," +
                        "\"contentColor\":{\"r\":130,\"g\":110,\"b\":247,\"a\":0.35}," +
                        "\"paddingColor\":{\"r\":147,\"g\":196,\"b\":125,\"a\":0.3}," +
                        "\"borderColor\":{\"r\":130,\"g\":110,\"b\":247,\"a\":0.85}," +
                        "\"marginColor\":{\"r\":246,\"g\":178,\"b\":107,\"a\":0.35}}}");
                }
                catch { }
                break;
        }
    }

    // Register the hardware media keys system-wide and route them to the page.
    static void SetupMediaKeys()
    {
        var hwnd = new WindowInteropHelper(win).Handle;
        var src = HwndSource.FromHwnd(hwnd);
        if (src == null) return;
        src.AddHook(HotkeyHook);
        // fsModifiers 0: the bare media transport keys. Best-effort — if another app
        // already owns one, that RegisterHotKey simply returns false.
        RegisterHotKey(hwnd, HK_PLAYPAUSE, 0, VK_MEDIA_PLAY_PAUSE);
        RegisterHotKey(hwnd, HK_NEXT, 0, VK_MEDIA_NEXT_TRACK);
        RegisterHotKey(hwnd, HK_PREV, 0, VK_MEDIA_PREV_TRACK);
        RegisterHotKey(hwnd, HK_STOP, 0, VK_MEDIA_STOP);
    }

    static IntPtr HotkeyHook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_HOTKEY)
        {
            int id = wParam.ToInt32();
            string act = id == HK_NEXT ? "next" : id == HK_PREV ? "prev" : (id == HK_PLAYPAUSE || id == HK_STOP) ? "playpause" : null;
            if (act != null)
            {
                handled = true;
                try { win.Dispatcher.InvokeAsync(() => { try { _ = wv.CoreWebView2.ExecuteScriptAsync("window.__hoqMedia && window.__hoqMedia('" + act + "')"); } catch { } }); } catch { }
            }
        }
        return IntPtr.Zero;
    }

    // Compact / mini player: shrink to a small always-on-top widget, and back.
    static bool miniOn = false;
    static Rect miniRestore;
    static bool miniWasMax = false;
    static void EnterMini()
    {
        if (miniOn) return;
        try
        {
            if (maxed) { miniWasMax = true; ToggleMaximize(); } else miniWasMax = false;
            miniRestore = new Rect(win.Left, win.Top, win.Width, win.Height);
            win.MinWidth = 0; win.MinHeight = 0;
            win.Width = 432; win.Height = 152;
            var wa = SystemParameters.WorkArea;
            win.Left = wa.Right - win.Width - 24; win.Top = wa.Top + 24;
            win.Topmost = true;
            miniOn = true;
        }
        catch { }
    }
    static void ExitMini()
    {
        if (!miniOn) return;
        try
        {
            win.Topmost = false;
            win.Width = miniRestore.Width; win.Height = miniRestore.Height;
            win.Left = miniRestore.X; win.Top = miniRestore.Y;
            if (miniWasMax) ToggleMaximize();
            miniOn = false;
        }
        catch { }
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

// Discord Rich Presence over the local Discord IPC pipe. Uses only the PUBLIC
// Client ID — no token/secret. Shows "Listening to <artist>" with the track and
// artist as clickable links, crisp cover art, a live progress bar, a paused
// badge, and "Listen on SoundCloud" / "Get holdonquietly" buttons.
static class DiscordRpc
{
    const string CLIENT_ID = "1523891530417442916";
    // Images are external URLs: the Discord app has no uploaded art assets, so the
    // "logo" asset key the old code used never rendered. raw.githubusercontent
    // serves image/png, which Discord proxies.
    const string RAW = "https://raw.githubusercontent.com/dwindles/holdonquietly-soundcloud/master/";
    const string LOGO_URL = RAW + "logo.png";
    const string PAUSED_URL = RAW + "assets/rpc/paused.png";
    const string RELEASE_URL = "https://github.com/dwindles/holdonquietly-soundcloud/releases/latest";
    static readonly TimeSpan PAUSE_HIDE_AFTER = TimeSpan.FromMinutes(5);

    public sealed class Track
    {
        public string Title, Artist, Cover, Url, ArtistUrl;
        public int Pos, Dur;
        public bool Paused;
        public string Status = "artist";   // member-list line: artist | song | app
        public bool Buttons = true;
        public bool PauseHide = true;       // clear the presence after a while paused
        internal long At;                   // unix time Pos was sampled
    }

    static NamedPipeClientStream pipe;
    static volatile bool ready = false;
    static readonly object gate = new object();   // serialises pipe writes + presence state
    static Track cur;              // what's showing (null = nothing playing / presence off)
    static string sentKey;         // identity of the last activity sent — dedupes ticks
    static long sentStart;
    static string loggedKey;
    static DateTime pausedSince;
    static bool hiddenForPause;
    // status_display_type and the *_url fields need a recent Discord client. If
    // Discord rejects an update we step down and resend instead of going dark:
    // 0 = everything, 1 = no status line / clickable links, 2 = also no buttons.
    static int compat = 0;
    static readonly string AppVersion = AppVer();

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
                _ = ReadLoop(p);
                // A fresh connection (often Discord restarting, maybe updated) gets
                // the full feature set again, then the current track.
                lock (gate) { compat = 0; sentKey = null; Push(true); }
                return;
            }
            catch { }
        }
    }

    // Discord frequently isn't running (or the pipe drops) when the app starts;
    // keep trying so presence shows up whenever Discord becomes available. The
    // paused-too-long check also lives here: a paused track sends no new ticks.
    public static async Task KeepAlive()
    {
        while (true)
        {
            await Task.Delay(8000);
            if (!ready || pipe == null || !pipe.IsConnected) { ready = false; await Connect(); }
            else lock (gate) { if (cur != null && cur.Paused) Push(false); }
        }
    }

    public static void Update(Track t)
    {
        lock (gate)
        {
            t.At = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            bool wasPaused = cur != null && cur.Paused;
            if (t.Paused) { if (!wasPaused || pausedSince == default) pausedSince = DateTime.UtcNow; }
            else { pausedSince = default; hiddenForPause = false; }
            cur = t;
            Push(false);
        }
    }

    public static void Clear()
    {
        lock (gate)
        {
            cur = null; sentKey = null; pausedSince = default; hiddenForPause = false;
            ClearActivity();
        }
    }

    // Caller holds `gate`.
    static void ClearActivity()
    {
        if (!ready) return;
        Send(1, JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["cmd"] = "SET_ACTIVITY",
            ["nonce"] = Guid.NewGuid().ToString(),
            ["args"] = new Dictionary<string, object> { ["pid"] = Environment.ProcessId },
        }));
    }

    // Send the current activity if it differs from what Discord already shows.
    // Caller holds `gate`.
    static void Push(bool force)
    {
        var t = cur;
        if (t == null) return;
        // Paused long enough → step off Discord rather than claim you're listening.
        if (t.Paused && t.PauseHide && pausedSince != default && DateTime.UtcNow - pausedSince >= PAUSE_HIDE_AFTER)
        {
            if (!hiddenForPause) { hiddenForPause = true; sentKey = null; ClearActivity(); }
            return;
        }
        hiddenForPause = false;
        bool timed = !t.Paused && t.Dur > 0 && t.Pos >= 0 && t.Pos <= t.Dur;
        long start = timed ? t.At - t.Pos : 0;
        string key = string.Join("\u001f", t.Title, t.Artist, t.Url, t.ArtistUrl, t.Cover, t.Paused,
            t.Status, t.Buttons, compat, timed ? t.Dur : 0);
        // The page ticks every few seconds while playing; only a seek moves the
        // start time by more than a second or two, so anything less is a repeat.
        // NOTE: never put a per-song "name" in the activity — Discord treats a new
        // name as a new activity and caches it, sticking presence on the old song.
        if (!force && key == sentKey && Math.Abs(start - sentStart) <= 2) return;
        sentKey = key; sentStart = start;
        if (ready) Send(1, Build(t, start));
    }

    static string Build(Track t, long start)
    {
        bool hasArtist = !string.IsNullOrWhiteSpace(t.Artist);
        string cover = BigCover(t.Cover);
        bool linkTrack = IsUrl(t.Url), linkArtist = hasArtist && IsUrl(t.ArtistUrl);

        var act = new Dictionary<string, object> { ["type"] = 2 };   // Listening
        act["details"] = Fit(t.Title);
        if (hasArtist) act["state"] = Fit(t.Artist);
        if (compat == 0)
        {
            // The member list reads "Listening to …" the artist (like a music app
            // does), the song, or the app's name.
            act["status_display_type"] = t.Status == "app" ? 0 : (t.Status == "song" || !hasArtist) ? 2 : 1;
            if (linkTrack) act["details_url"] = t.Url;
            if (linkArtist) act["state_url"] = t.ArtistUrl;
        }
        if (start > 0) act["timestamps"] = new Dictionary<string, object> { ["start"] = start, ["end"] = start + t.Dur };

        var assets = new Dictionary<string, object>
        {
            ["large_image"] = cover ?? LOGO_URL,
            ["large_text"] = "holdonquietly",   // the line under the artist: the app watermark
        };
        if (compat == 0 && linkTrack) assets["large_url"] = t.Url;
        if (t.Paused)
        {
            assets["small_image"] = PAUSED_URL;
            assets["small_text"] = "Paused";
        }
        else if (cover != null)   // with no cover the logo is already the big image
        {
            assets["small_image"] = LOGO_URL;
            assets["small_text"] = AppVersion.Length > 0 ? "holdonquietly v" + AppVersion : "holdonquietly";
            if (compat == 0) assets["small_url"] = RELEASE_URL;
        }
        act["assets"] = assets;

        // Discord shows these to everyone except you — that's normal, not a bug.
        if (t.Buttons && compat < 2)
        {
            var buttons = new List<object>();
            if (IsUrl(t.Url, 512)) buttons.Add(new Dictionary<string, object> { ["label"] = "Listen on SoundCloud", ["url"] = t.Url });
            buttons.Add(new Dictionary<string, object> { ["label"] = "Get holdonquietly", ["url"] = RELEASE_URL });
            act["buttons"] = buttons;
        }

        return JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["cmd"] = "SET_ACTIVITY",
            ["nonce"] = Guid.NewGuid().ToString(),
            ["args"] = new Dictionary<string, object> { ["pid"] = Environment.ProcessId, ["activity"] = act },
        });
    }

    // Discord rejects details/state/text under 2 or over 128 characters, and one
    // bad field fails the whole update — so every string is fitted.
    static string Fit(string s, int max = 128)
    {
        s = (s ?? "").Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim();
        if (s.Length > max)
        {
            int cut = max - 1;
            if (char.IsHighSurrogate(s[cut - 1])) cut--;   // never split an emoji
            s = s.Substring(0, cut).TrimEnd() + "…";
        }
        while (s.Length < 2) s += "⠀";   // blank Braille cell: invisible, but not whitespace Discord would trim
        return s;
    }

    static bool IsUrl(string u, int max = 256) =>
        !string.IsNullOrEmpty(u) && u.Length <= max &&
        Uri.TryCreate(u, UriKind.Absolute, out var x) && (x.Scheme == Uri.UriSchemeHttps || x.Scheme == Uri.UriSchemeHttp);

    // The page hands over the player's 200px artwork; SoundCloud's CDN serves every
    // artwork at 500px too, which keeps the cover sharp in Discord's card.
    static string BigCover(string c) => IsUrl(c)
        ? System.Text.RegularExpressions.Regex.Replace(c, @"-(t\d+x\d+|large|small|crop|badge|tiny|mini)\.(jpg|jpeg|png|webp)", "-t500x500.$2")
        : null;

    static string AppVer()
    {
        try { var v = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version; return v == null ? "" : v.ToString(3); }
        catch { return ""; }
    }

    static void Send(int op, string json)
    {
        lock (gate)
        {
            var p = pipe;
            if (p == null || !p.IsConnected) return;
            try
            {
                byte[] data = Encoding.UTF8.GetBytes(json);
                byte[] buf = new byte[8 + data.Length];
                BitConverter.GetBytes(op).CopyTo(buf, 0);
                BitConverter.GetBytes(data.Length).CopyTo(buf, 4);
                data.CopyTo(buf, 8);
                p.Write(buf, 0, buf.Length);
                p.Flush();
            }
            catch { ready = false; }
        }
    }

    static async Task ReadLoop(NamedPipeClientStream p)
    {
        byte[] head = new byte[8];
        try
        {
            while (p.IsConnected)
            {
                if (!await ReadExact(p, head, 8)) break;
                int op = BitConverter.ToInt32(head, 0);
                int len = BitConverter.ToInt32(head, 4);
                if (len < 0 || len > (1 << 20)) break;
                byte[] payload = new byte[len];
                if (len > 0 && !await ReadExact(p, payload, len)) break;
                if (op == 2) break;            // Discord closed the connection
                if (op == 1) OnFrame(payload);
            }
        }
        catch { }
        if (pipe == p) ready = false;
    }

    static async Task<bool> ReadExact(NamedPipeClientStream p, byte[] buf, int n)
    {
        int r = 0;
        while (r < n)
        {
            int k = await p.ReadAsync(buf, r, n - r);
            if (k <= 0) return false;
            r += k;
        }
        return true;
    }

    // Discord answers every command. An ERROR reply to SET_ACTIVITY used to be
    // read and thrown away, so a field the client didn't accept silently took the
    // presence down. Now it's logged and the update is resent with fewer of the
    // newer fields (see `compat`).
    static void OnFrame(byte[] payload)
    {
        try
        {
            var r = JsonDocument.Parse(payload).RootElement;
            if (!r.TryGetProperty("cmd", out var c) || c.ValueKind != JsonValueKind.String || c.GetString() != "SET_ACTIVITY") return;
            bool error = r.TryGetProperty("evt", out var e) && e.ValueKind == JsonValueKind.String && e.GetString() == "ERROR";
            lock (gate)
            {
                if (error)
                {
                    string msg = r.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object &&
                                 d.TryGetProperty("message", out var mm) ? mm.ToString() : "";
                    Program.Log("RP rejected (level " + compat + "): " + msg);
                    if (compat < 2) { compat++; sentKey = null; Push(true); }
                }
                else if (sentKey != null && sentKey != loggedKey)
                {
                    loggedKey = sentKey;
                    Program.Log("RP ok (level " + compat + ")");
                }
            }
        }
        catch { }
    }
}
