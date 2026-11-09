import type { SandboxProviderId } from "@armada/core";
import { PROVIDER_LABELS } from "@/lib/golden-form";
import { cn } from "@/lib/utils";

/**
 * The provider's own mark, traced from its official icon (boat.dev/icon.svg, modal.com/assets/favicon.svg) with
 * solid fills so a table of them repeats no gradient id. Decorative: the name always sits beside it.
 */
function ProviderMark({ provider, className }: { provider: SandboxProviderId; className?: string }) {
  if (provider === "boat")
    return (
      <svg viewBox="0 0 498 463" aria-hidden="true" className={cn("size-3.5 shrink-0", className)} data-provider-mark>
        <path
          className="fill-[#263FA9] dark:fill-[#8C9EEB]"
          d="M490.123 361.461C494.464 361.461 497.985 364.978 497.985 369.323V403.916C497.985 408.256 494.464 411.777 490.123 411.777H473.317C468.941 411.777 465.396 415.327 465.396 419.699V454.232C465.396 458.573 461.875 462.094 457.534 462.094H84.3579C83.1446 462.094 81.9773 461.511 81.2263 460.558C52.4607 424.054 51.9691 423.595 7.86426 411.777C3.67043 410.653 0 408.256 0 403.916V369.323C0 364.978 3.52235 361.461 7.86426 361.461H490.123ZM234.167 4.81756C238.589 -2.56834 249.679 -1.18229 252.148 7.06463L321.938 240.22L244.366 338.334H51.9617C44.2696 338.334 39.5154 329.947 43.4665 323.347L234.167 4.81756ZM453.056 132.26C451.192 124.166 440.791 121.826 435.64 128.341L282.295 322.292C277.163 328.784 281.786 338.334 290.063 338.334H488.08C494.445 338.334 499.157 332.414 497.728 326.21L453.056 132.26Z"
        />
      </svg>
    );
  if (provider !== "modal") return null;
  return (
    <svg viewBox="0 64 300 172" aria-hidden="true" className={cn("h-3 w-5 shrink-0", className)} data-provider-mark>
      <path
        fill="#62DE61"
        d="M121.683 75.25L149.997 124L91.4816 224.75C90.3128 226.757 88.155 228 85.8174 228H32.9664C31.7976 228 30.6778 227.691 29.697 227.131C28.7161 226.57 27.8906 225.758 27.3021 224.75L0.876625 179.25C-0.292208 177.243 -0.292208 174.765 0.876625 172.75L57.512 75.25C58.0923 74.2425 58.9259 73.43 59.9068 72.8694C60.8876 72.3088 62.0074 72 63.1762 72H116.027C118.365 72 120.523 73.2431 121.692 75.25H121.683ZM299.125 172.75L242.49 75.25C241.91 74.2425 241.076 73.43 240.095 72.8694C239.114 72.3088 237.995 72 236.826 72H183.975C181.637 72 179.479 73.2431 178.311 75.25L149.997 124L208.512 224.75C209.681 226.757 211.839 228 214.177 228H267.027C268.196 228 269.316 227.691 270.297 227.131C271.278 226.57 272.103 225.758 272.692 224.75L299.117 179.25C300.286 177.243 300.286 174.765 299.117 172.75H299.125Z"
      />
      <path
        fill="#09AF58"
        d="M149.997 124H89.5936L29.697 227.131C30.6778 227.691 31.7976 228 32.9664 228H85.8174C88.155 228 90.3128 226.757 91.4816 224.75L149.997 124ZM299.125 179.25C299.706 178.243 300 177.121 300 176H240.61L210.915 227.131C211.896 227.691 213.016 228 214.185 228H267.036C269.373 228 271.531 226.757 272.7 224.75L299.125 179.25Z"
      />
    </svg>
  );
}

/** A sandbox's provider as persisted on its row: the mark, then the same name the detail page shows. */
export function ProviderName({ provider, className }: { provider: SandboxProviderId; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} data-provider={provider}>
      <ProviderMark provider={provider} />
      {PROVIDER_LABELS[provider] ?? provider}
    </span>
  );
}
