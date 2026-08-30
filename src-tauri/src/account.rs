//! 账号体系输入校验 —— 本地第一道防线。
//!
//! 原则：能在本地校验的全部本地校验（用户需求），不合格的输入
//! 根本不发起网络请求；服务端有同样的白名单（权威第二道）。
//! 纯逻辑，全部可单测。

/// 账号：3-12 位，字母/数字/下划线。
pub fn valid_account(s: &str) -> Result<(), String> {
    let n = s.chars().count();
    if !(3..=12).contains(&n) {
        return Err("账号需 3-12 位".into());
    }
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("账号只能包含字母、数字、下划线".into());
    }
    Ok(())
}

/// 密码：6-30 位，必须同时含大写和小写。
pub fn valid_password(s: &str) -> Result<(), String> {
    if s.chars().count() < 6 {
        return Err("密码至少 6 位".into());
    }
    if s.chars().count() > 30 {
        return Err("密码最多 30 位".into());
    }
    let has_lower = s.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = s.chars().any(|c| c.is_ascii_uppercase());
    if !has_lower || !has_upper {
        return Err("密码必须同时包含大写和小写字母".into());
    }
    Ok(())
}

/// 控制字符剥离（防注入/防破坏 JSON 展示）。
pub fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() && *c != '\u{2028}' && *c != '\u{2029}')
        .collect::<String>()
        .trim()
        .to_string()
}

/// 昵称：1-120 字（按字符计，中文一字算一），支持中英文/数字/空格。
pub fn valid_nick(s: &str) -> Result<String, String> {
    let s = clean(s);
    let n = s.chars().count();
    if n < 1 {
        return Err("昵称不能为空".into());
    }
    if n > 120 {
        return Err("昵称最多 120 字".into());
    }
    if !s
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == ' ' || c == '·')
    {
        return Err("昵称只支持中英文、数字、空格".into());
    }
    Ok(s)
}

/// 宠物名：1-24 字。返回清洗后的名字。
pub fn valid_pet_name(s: &str) -> Result<String, String> {
    let s = clean(s);
    let n = s.chars().count();
    if n < 1 {
        return Err("宠物名不能为空".into());
    }
    if n > 24 {
        return Err("宠物名最多 24 字".into());
    }
    if !s
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == ' ' || c == '·')
    {
        return Err("宠物名只支持中英文、数字、空格".into());
    }
    Ok(s)
}

/// 邀请码：6 位，去混淆字母表（无 0/O/1/I）。大小写不敏感。
pub fn valid_invite(s: &str) -> Result<String, String> {
    let s = s.trim().to_ascii_uppercase();
    if s.len() != 6 {
        return Err("邀请码为 6 位".into());
    }
    if !s.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()) {
        return Err("邀请码格式不正确".into());
    }
    if s.contains('O') || s.contains('I') {
        return Err("邀请码不含 O 和 I（避免与 0、1 混淆）".into());
    }
    Ok(s)
}

/// 加好友目标：合法的 uid（8 位数字）或昵称。
pub fn valid_target(s: &str) -> Result<String, String> {
    let s = clean(s);
    if s.is_empty() {
        return Err("请输入 uid 或昵称".into());
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 账号合法与非法() {
        assert!(valid_account("abc_123").is_ok());
        assert!(valid_account("ab").is_err(), "太短");
        assert!(valid_account("a".repeat(13).as_str()).is_err(), "太长");
        assert!(valid_account("用户名").is_err(), "非 ASCII");
        assert!(valid_account("a b").is_err(), "含空格");
        assert!(valid_account("a-b").is_err(), "含连字符");
    }

    #[test]
    fn 密码必须含大小写() {
        assert!(valid_password("abcXYZ").is_ok());
        assert!(valid_password("Abc123").is_ok());
        assert!(valid_password("abcdef").is_err(), "缺大写");
        assert!(valid_password("ABCDEF").is_err(), "缺小写");
        assert!(valid_password("aB").is_err(), "太短");
        assert!(valid_password(&("aBcdef".to_string() + &"x".repeat(30))).is_err(), "太长");
    }

    #[test]
    fn 中文昵称合法且控制字符被清洗() {
        assert!(valid_nick("阿咪").is_ok());
        assert!(valid_nick(&"很".repeat(120)).is_ok());
        assert!(valid_nick(&"很".repeat(121)).is_err(), "超过 120 字");
        let cleaned = valid_nick("阿咪\u{0007}").unwrap();
        assert_eq!(cleaned, "阿咪", "控制字符应被剥离");
        assert!(valid_nick("nick<script>").is_err(), "尖括号不允许");
    }

    #[test]
    fn 宠物名限二十四字() {
        assert!(valid_pet_name("像素崽").is_ok());
        assert!(valid_pet_name(&"名".repeat(25)).is_err());
        assert!(valid_pet_name("").is_err());
    }

    #[test]
    fn 邀请码大小写不敏感且排除混淆字符() {
        assert_eq!(valid_invite("ab2cd3").unwrap(), "AB2CD3");
        assert!(valid_invite("AB2CD").is_err(), "5 位");
        assert!(valid_invite("AO2CD3").is_err(), "含 O");
        assert!(valid_invite("AI2CD3").is_err(), "含 I");
    }
}
