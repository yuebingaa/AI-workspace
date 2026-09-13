// Built as a Windows GUI-subsystem executable. No console is created, including
// when Windows Terminal is the default console host. No UI or shell is used.
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class AgentCanvasTaskHost
{
    private static readonly object LogGate = new object();
    private static string logFile;

    private static string Redact(string message)
    {
        foreach (DictionaryEntry item in Environment.GetEnvironmentVariables())
        {
            string value = item.Value as string;
            if (value != null && value.Length > 5 && Regex.IsMatch((string)item.Key, "key|secret|token|password", RegexOptions.IgnoreCase))
                message = message.Replace(value, "[redacted]");
        }
        message = Regex.Replace(message, @"\bBearer\s+[^\s""']+", "Bearer [redacted]", RegexOptions.IgnoreCase);
        message = Regex.Replace(message, @"\bsk-[\w-]+", "[redacted]");
        return Regex.Replace(message, @"((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+", "$1[redacted]", RegexOptions.IgnoreCase);
    }

    private static void Log(string message)
    {
        if (logFile == null || message == null) return;
        lock (LogGate)
        {
            try
            {
                if (File.Exists(logFile) && new FileInfo(logFile).Length > 5 * 1024 * 1024)
                {
                    for (int i = 4; i >= 1; i--)
                        if (File.Exists(logFile + "." + i))
                        {
                            if (File.Exists(logFile + "." + (i + 1))) File.Delete(logFile + "." + (i + 1));
                            File.Move(logFile + "." + i, logFile + "." + (i + 1));
                        }
                    if (File.Exists(logFile + ".1")) File.Delete(logFile + ".1");
                    File.Move(logFile, logFile + ".1");
                }
                string safe = message.Length > 65536 ? "[oversized log line omitted]" : Redact(message);
                File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + safe + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (IOException) { /* A competing duplicate host must not fail because a log is busy. */ }
            catch (UnauthorizedAccessException) { }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || args[0] != "--runtime-root") return 2;
            string root = Path.GetFullPath(args[1]);
            if (root == Path.GetPathRoot(root) || !Directory.Exists(root)) return 2;
            root = root.TrimEnd(Path.DirectorySeparatorChar);
            Directory.CreateDirectory(Path.Combine(root, "logs"));
            logFile = Path.Combine(root, "logs", "launcher.log");
            string node = Path.Combine(root, "runtime", "node.exe");
            string entry = Path.Combine(root, "bin", "supervisor.mjs");
            if (!File.Exists(node) || !File.Exists(entry) || !File.Exists(Path.Combine(root, "config.json")))
                throw new FileNotFoundException("Runtime files are incomplete; run site:install or site:update-manager.");
            string identity;
            using (SHA256 sha = SHA256.Create())
                identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
            using (Mutex mutex = new Mutex(false, @"Local\AgentCanvasHost-" + identity))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired) { Log("Existing launcher is active; duplicate skipped successfully."); return 0; }
                try
                {
                    using (Process child = new Process())
                    {
                        child.StartInfo = new ProcessStartInfo
                        {
                            FileName = node,
                            Arguments = "\"" + entry + "\" \"" + root + "\"",
                            WorkingDirectory = root,
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            WindowStyle = ProcessWindowStyle.Hidden,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true,
                            RedirectStandardInput = true,
                            StandardOutputEncoding = Encoding.UTF8,
                            StandardErrorEncoding = Encoding.UTF8
                        };
                        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("stdout: " + e.Data); };
                        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("stderr: " + e.Data); };
                        Log("Launcher started pid=" + Process.GetCurrentProcess().Id + "; console-free mode.");
                        child.Start();
                        child.StandardInput.Close();
                        Log("Supervisor started pid=" + child.Id + ".");
                        child.BeginOutputReadLine();
                        child.BeginErrorReadLine();
                        child.WaitForExit(); // Also waits for both redirected output streams to drain.
                        Log("Supervisor exited code=" + child.ExitCode + ".");
                        return child.ExitCode;
                    }
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            Log("Launcher failed: " + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
