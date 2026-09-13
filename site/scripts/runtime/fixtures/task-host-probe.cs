using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
internal static class HostProbe
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    private static int Main(string[] args)
    {
        string root = args[1];
        File.WriteAllText(Path.Combine(root, "probe.json"), "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"hasConsole\":" + (GetConsoleWindow() != IntPtr.Zero ? "true" : "false") + "}");
        Console.WriteLine("stdout-ready");
        Console.Error.WriteLine("Authorization=private-fixture Bearer abcdef sk-test-secret API_KEY=example-key");
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (!File.Exists(Path.Combine(root, "finish")) && DateTime.UtcNow < deadline) Thread.Sleep(50);
        return File.Exists(Path.Combine(root, "fail")) ? 23 : 0;
    }
}
