# Runs one command line under the token an ordinary Windows user would have, and
# exits with its exit code.
#
# A hosted runner runs every step as an administrator with UAC off, so there is no
# split token to fall back to: everything the job starts is elevated, and Ember
# reads that — correctly — as being the elevated window. That window keeps its user
# data one directory down and never starts the Claude Code bridge, so the suites
# that need an ordinary window cannot pass there, and every other suite tests the
# path users mostly do not run.
#
# This asks Windows for what `runas /trustlevel:0x20000` asks it for — the SAFER
# "normal user" level — and starts the command with that token: the same user, the
# same profile, the same desktop, but with Administrators kept only as a group that
# can deny access and never grant it, the administrator privileges gone, and the
# integrity level lowered to medium. That is the shape of a filtered UAC token, so
# the app's own elevation check answers "no" for the reason it would on a user's
# machine. Nothing in the app is told it is under test.
#
# runas itself is not used because it starts the command detached, in a console of
# its own, and returns before it finishes: no output reaches the log and no exit
# code comes back. Here the child inherits this process's stdout and stderr and is
# waited for.
#
# Run: pwsh .github/unelevated.ps1 '"C:\path\to\node.exe" scripts/gate.mjs --only ide'
param(
  [Parameter(Mandatory, Position = 0)][string]$CommandLine
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class Unelevated {
  const uint SAFER_SCOPEID_USER = 2;
  const uint SAFER_LEVELID_NORMALUSER = 0x20000;
  const uint SAFER_LEVEL_OPEN = 1;
  const int TokenIntegrityLevel = 25;
  const uint SE_GROUP_INTEGRITY = 0x20;
  const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
  const uint HANDLE_FLAG_INHERIT = 1;
  const int STARTF_USESTDHANDLES = 0x100;
  const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferCreateLevel(uint scope, uint level, uint openFlags, out IntPtr hLevel, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferComputeTokenFromLevel(IntPtr hLevel, IntPtr inToken, out IntPtr outToken, uint flags, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SaferCloseLevel(IntPtr hLevel);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
  [DllImport("advapi32.dll")]
  static extern int GetLengthSid(IntPtr psid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, int length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr h);

  static Exception Fail(string what) {
    return new Win32Exception(Marshal.GetLastWin32Error(), what);
  }

  static IntPtr Inheritable(int which) {
    IntPtr h = GetStdHandle(which);
    if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    return h;
  }

  public static int Run(string commandLine, string cwd) {
    IntPtr level, token;
    if (!SaferCreateLevel(SAFER_SCOPEID_USER, SAFER_LEVELID_NORMALUSER, SAFER_LEVEL_OPEN, out level, IntPtr.Zero))
      throw Fail("SaferCreateLevel");
    try {
      if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero))
        throw Fail("SaferComputeTokenFromLevel");
    } finally { SaferCloseLevel(level); }

    // SAFER leaves the integrity level where it was, which on a runner is high.
    // A filtered UAC token is medium, so this is lowered to match. Lowering needs
    // no privilege; raising would.
    IntPtr medium;
    if (!ConvertStringSidToSid("S-1-16-8192", out medium)) throw Fail("ConvertStringSidToSid");
    TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
    label.Label.Sid = medium;
    label.Label.Attributes = SE_GROUP_INTEGRITY;
    int size = Marshal.SizeOf(label) + GetLengthSid(medium);
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(label, buf, false);
      if (!SetTokenInformation(token, TokenIntegrityLevel, buf, size)) throw Fail("SetTokenInformation(integrity)");
    } finally { Marshal.FreeHGlobal(buf); LocalFree(medium); }

    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = Inheritable(STD_INPUT_HANDLE);
    si.hStdOutput = Inheritable(STD_OUTPUT_HANDLE);
    si.hStdError = Inheritable(STD_ERROR_HANDLE);
    PROCESS_INFORMATION pi;
    // A null environment inherits this one; a null desktop inherits this desktop.
    if (!CreateProcessAsUser(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero,
        true, 0, IntPtr.Zero, cwd, ref si, out pi))
      throw Fail("CreateProcessAsUser");
    CloseHandle(token);
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint code;
    if (!GetExitCodeProcess(pi.hProcess, out code)) throw Fail("GetExitCodeProcess");
    CloseHandle(pi.hProcess);
    return unchecked((int)code);
  }
}
'@

Write-Host "unelevated: $CommandLine"
$code = [Unelevated]::Run($CommandLine, (Get-Location).Path)
Write-Host "unelevated: exit $code"
exit $code
