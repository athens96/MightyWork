import type { User } from "../types";

/** 프로필 사진, 없으면 이름 첫 글자 */
export function Avatar({ user, size = 20 }: { user: User | null | undefined; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.48) };
  if (!user) return <span className="avatar avatar-empty" style={style} title="미지정" />;
  const label = user.name || user.email;
  return user.picture ? (
    <img className="avatar" src={user.picture} alt="" title={label} style={style} referrerPolicy="no-referrer" />
  ) : (
    <span className="avatar" title={label} style={style}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
