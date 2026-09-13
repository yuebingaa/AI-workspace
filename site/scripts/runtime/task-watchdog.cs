using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

// Short-lived GUI-subsystem check. It never launches a shell or Node directly.
// The main long-lived task has no repeat trigger; repeating this check avoids
// Task Scheduler recording ERROR_REQUEST_REFUSED for an already-running task.
internal static class AgentCanvasWatchdog
{
    private static object Invoke(object instance, string name, BindingFlags kind, params object[] arguments)
    {
        return instance.GetType().InvokeMember(name, kind, null, instance, arguments);
    }

    [STAThread]
    private static int Main(string[] args)
    {
        string log = null;
        object service = null, folder = null, task = null, running = null;
        try
        {
            if (args.Length != 4 || args[0] != "--runtime-root" || args[2] != "--task-name" || !Regex.IsMatch(args[3], "^AgentCanvas-[a-f0-9]{10}$")) return 2;
            string root = Path.GetFullPath(args[1]);
            if (!File.Exists(Path.Combine(root, "config.json"))) return 2;
            log = Path.Combine(root, "logs", "watchdog.log");
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
            Invoke(service, "Connect", BindingFlags.InvokeMethod);
            folder = Invoke(service, "GetFolder", BindingFlags.InvokeMethod, "\\");
            task = Invoke(folder, "GetTask", BindingFlags.InvokeMethod, args[3]);
            int state = Convert.ToInt32(Invoke(task, "State", BindingFlags.GetProperty));
            // 1=disabled (respect explicit administrator choice), 2=queued, 4=running.
            if (state == 1 || state == 2 || state == 4) return 0;
            running = Invoke(task, "Run", BindingFlags.InvokeMethod, new object[] { null });
            return 0;
        }
        catch (Exception error)
        {
            if (log != null)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(log));
                    if (File.Exists(log) && new FileInfo(log).Length > 5 * 1024 * 1024)
                    {
                        if (File.Exists(log + ".1")) File.Delete(log + ".1");
                        File.Move(log, log + ".1");
                    }
                    Exception cause = error.InnerException ?? error;
                    File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " Watchdog failed: " + cause.GetType().Name + " HRESULT=0x" + Marshal.GetHRForException(cause).ToString("X8") + Environment.NewLine);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            return 1;
        }
        finally
        {
            foreach (object instance in new object[] { running, task, folder, service })
                if (instance != null && Marshal.IsComObject(instance)) Marshal.FinalReleaseComObject(instance);
        }
    }
}
