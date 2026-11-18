using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using System.Windows.Threading;

// ─────────────────────────────────────────────────────────────────────────────
// Song pop-up: a small cover + title card in the corner of the screen when the
// song changes while you're in another app or a game. Off by default (Settings →
// Desktop). Never takes focus and clicks pass straight through it, so it can't
// interrupt whatever you're doing.
// ─────────────────────────────────────────────────────────────────────────────
static class SongToast
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint dwFlags; }

    static string last;
    static bool primed;
    static Window cur;
    const double W = 340, H = 76;

    public static void MaybeShow(string title, string artist, string cover, bool on, bool paused)
    {
        if (string.IsNullOrEmpty(title) || title == last) return;
        last = title;
        if (!primed) { primed = true; return; }        // not for the song already loaded at launch
        if (!on || paused) return;
        try
        {
            var main = Program.MainWin;
            var mainH = main == null ? IntPtr.Zero : new WindowInteropHelper(main).Handle;
            if (mainH != IntPtr.Zero && GetForegroundWindow() == mainH && main.IsVisible && main.WindowState != WindowState.Minimized) return;
            Show(title, artist, cover);
        }
        catch { }
    }

    public static void ShowNow(string title, string artist, string cover) { try { Show(title, artist, cover); } catch { } }

    static void Show(string title, string artist, string cover)
    {
        try { cur?.Close(); } catch { }
        var art = new Border { Width = 52, Height = 52, CornerRadius = new CornerRadius(8), Background = new SolidColorBrush(Color.FromRgb(34, 34, 40)) };
        try
        {
            if (!string.IsNullOrEmpty(cover) && cover.StartsWith("https://"))
                art.Background = new ImageBrush(new BitmapImage(new Uri(cover.Replace("-large.", "-t200x200.")))) { Stretch = Stretch.UniformToFill };
        }
        catch { }
        var text = new StackPanel { Margin = new Thickness(12, 0, 4, 0), VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = "Now playing", FontSize = 10.5, Foreground = new SolidColorBrush(Color.FromRgb(142, 142, 153)) });
        text.Children.Add(new TextBlock { Text = title, FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 1, 0, 0) });
        if (!string.IsNullOrEmpty(artist))
            text.Children.Add(new TextBlock { Text = artist, FontSize = 12.5, Foreground = new SolidColorBrush(Color.FromRgb(176, 176, 186)), TextTrimming = TextTrimming.CharacterEllipsis });
        var row = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(art, Dock.Left);
        row.Children.Add(art); row.Children.Add(text);
        var card = new Border
        {
            CornerRadius = new CornerRadius(14), Padding = new Thickness(12),
            Background = new SolidColorBrush(Color.FromArgb(236, 18, 18, 22)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(40, 255, 255, 255)), BorderThickness = new Thickness(1),
            Child = row, RenderTransform = new TranslateTransform(0, 10),
        };
        var w = new Window
        {
            WindowStyle = WindowStyle.None, AllowsTransparency = true, Background = Brushes.Transparent,
            Topmost = true, ShowInTaskbar = false, ShowActivated = false, ResizeMode = ResizeMode.NoResize,
            Width = W, Height = H, Left = -10000, Top = -10000, Content = card, Opacity = 0, Focusable = false,
            FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI"),
        };
        w.SourceInitialized += (s, e) =>
        {
            try
            {
                var h = new WindowInteropHelper(w).Handle;
                // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT (click-through) | WS_EX_TOPMOST
                SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x08000000 | 0x80 | 0x20 | 0x8);
                // bottom-right of the screen you're on (the one with the focused app/game)
                var mon = MonitorFromWindow(GetForegroundWindow(), 2);
                var mi = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
                if (GetMonitorInfo(mon, ref mi))
                {
                    double k = 1; try { uint d = GetDpiForWindow(h); if (d > 0) k = d / 96.0; } catch { }
                    int pw = (int)Math.Round(W * k), ph = (int)Math.Round(H * k), pad = (int)Math.Round(18 * k);
                    SetWindowPos(h, new IntPtr(-1), mi.rcWork.Right - pw - pad, mi.rcWork.Bottom - ph - pad, pw, ph, 0x0010 | 0x0040);   // NOACTIVATE | SHOWWINDOW
                }
            }
            catch { }
        };
        cur = w;
        w.Show();
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        w.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(180)));
        ((TranslateTransform)card.RenderTransform).BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(10, 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = ease });
        var t = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4.5) };
        t.Tick += (s, e) =>
        {
            t.Stop();
            var fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(320));
            fade.Completed += (s2, e2) => { try { w.Close(); } catch { } if (cur == w) cur = null; };
            w.BeginAnimation(UIElement.OpacityProperty, fade);
        };
        t.Start();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Taskbar thumbnail buttons: previous / play-pause / next when you hover the app
// on the taskbar. They press SoundCloud's own player buttons.
// ─────────────────────────────────────────────────────────────────────────────
static class ThumbBar
{
    static ThumbButtonInfo playBtn;
    static ImageSource playImg, pauseImg;
    static bool playing;

    static ImageSource Icon(string path)
    {
        var g = new GeometryDrawing(Brushes.White, null, Geometry.Parse(path));
        // pad to a fixed 24x24 box so every icon is the same size and centered
        var dg = new DrawingGroup();
        dg.Children.Add(new GeometryDrawing(Brushes.Transparent, null, new RectangleGeometry(new Rect(0, 0, 24, 24))));
        dg.Children.Add(g);
        var img = new DrawingImage(dg); img.Freeze();
        return img;
    }

    public static void Init(Window win)
    {
        try
        {
            playImg = Icon("M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z");
            pauseImg = Icon("M6.5 5h3.5v14H6.5z M14 5h3.5v14H14z");
            var prev = new ThumbButtonInfo { Description = "Previous", ImageSource = Icon("M6 5h2.5v14H6z M19 5.8v12.4a.8.8 0 0 1-1.2.7L9.5 12.7a.8.8 0 0 1 0-1.4l8.3-6.2a.8.8 0 0 1 1.2.7z"), DismissWhenClicked = false };
            playBtn = new ThumbButtonInfo { Description = "Play", ImageSource = playImg, DismissWhenClicked = false };
            var next = new ThumbButtonInfo { Description = "Next", ImageSource = Icon("M15.5 5H18v14h-2.5z M5 5.8v12.4a.8.8 0 0 0 1.2.7l8.3-6.2a.8.8 0 0 0 0-1.4L6.2 5.1a.8.8 0 0 0-1.2.7z"), DismissWhenClicked = false };
            prev.Click += (s, e) => Program.RunPageJs("(function(){var b=document.querySelector('.playControls .skipControl__previous');b&&b.click();})()");
            playBtn.Click += (s, e) => Program.RunPageJs("(function(){var b=document.querySelector('.playControls .playControls__play');b&&b.click();})()");
            next.Click += (s, e) => Program.RunPageJs("(function(){var b=document.querySelector('.playControls .skipControl__next');b&&b.click();})()");
            var tii = win.TaskbarItemInfo ?? new TaskbarItemInfo();
            tii.ThumbButtonInfos = new ThumbButtonInfoCollection { prev, playBtn, next };
            win.TaskbarItemInfo = tii;
        }
        catch { }
    }

    public static void SetPlaying(bool p)
    {
        if (playBtn == null || p == playing) return;
        playing = p;
        try { playBtn.ImageSource = p ? pauseImg : playImg; playBtn.Description = p ? "Pause" : "Play"; } catch { }
    }
}
