use tauri::{
    command,
    plugin::{Builder, TauriPlugin},
    Runtime,
};

// The `uwuify` crate is SIMD-only and only exists on x86/x86_64.
#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
fn uwuify(value: &str) -> String {
    uwuifier::uwuify_str_sse(value)
}

// Portable fallback for other CPUs (e.g. Apple Silicon): l/r -> w, and
// "n" + vowel at the start of a word -> "ny" + vowel.
#[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
fn uwuify(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len() + value.len() / 4);
    for (i, &c) in chars.iter().enumerate() {
        match c {
            'l' | 'r' => out.push('w'),
            'L' | 'R' => out.push('W'),
            'n' | 'N' => {
                out.push(c);
                let word_start = i == 0 || !chars[i - 1].is_alphanumeric();
                let next_is_vowel = chars
                    .get(i + 1)
                    .is_some_and(|n| "aeiouAEIOU".contains(*n));
                if word_start && next_is_vowel {
                    out.push(if c == 'N' { 'Y' } else { 'y' });
                }
            }
            _ => out.push(c),
        }
    }
    out
}

#[command]
fn translate(value: String) -> String {
    uwuify(value.as_str())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("uwu")
        .invoke_handler(tauri::generate_handler![translate])
        .build()
}
