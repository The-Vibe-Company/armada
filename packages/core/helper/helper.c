/* Slice 0: no filesystem, environment, network or authority. Linux syscalls only. */
static const char report[] = "{\"version\":\"0.1.0\",\"protocol\":1,\"capabilities\":[\"diagnose\"]}\n";
#if defined(__x86_64__)
static long call(long n, long a, long b, long c) {
  register long rax __asm__("rax") = n;
  __asm__ volatile("syscall" : "+a"(rax) : "D"(a), "S"(b), "d"(c) : "rcx", "r11", "memory");
  return rax;
}
#define WRITE 1
#define EXIT 60
#elif defined(__aarch64__)
static long call(long n, long a, long b, long c) {
  register long x8 __asm__("x8") = n;
  register long x0 __asm__("x0") = a;
  register long x1 __asm__("x1") = b;
  register long x2 __asm__("x2") = c;
  __asm__ volatile("svc 0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory");
  return x0;
}
#define WRITE 64
#define EXIT 93
#else
#error Unsupported helper architecture
#endif
void _start(void) {
  long written = call(WRITE, 1, (long)report, sizeof(report)-1);
  call(EXIT, written == sizeof(report)-1 ? 0 : 1, 0, 0);
  __builtin_unreachable();
}
