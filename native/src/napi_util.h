// Small helpers over the Node-API C interface (no node-addon-api dependency).
#pragma once

#import <Foundation/Foundation.h>

#include <node_api.h>

namespace lens {

inline napi_value MakeString(napi_env env, NSString *s) {
  napi_value v;
  NSData *bytes = [s ?: @"" dataUsingEncoding:NSUTF8StringEncoding];
  // Explicit length: AX text may legitimately contain NUL.
  napi_create_string_utf8(env, (const char *)bytes.bytes, bytes.length, &v);
  return v;
}

inline napi_value MakeError(napi_env env, const char *code, const char *message) {
  napi_value c, m, err;
  napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &c);
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &m);
  napi_create_error(env, c, m, &err);
  return err;
}

inline void ThrowCode(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
}

inline bool ValueToString(napi_env env, napi_value v, NSString **out) {
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) return false;
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  NSMutableData *buf = [NSMutableData dataWithLength:len + 1];
  napi_get_value_string_utf8(env, v, (char *)buf.mutableBytes, len + 1, &len);
  *out = [[NSString alloc] initWithBytes:buf.bytes length:len encoding:NSUTF8StringEncoding];
  return *out != nil;
}

inline bool GetProp(napi_env env, napi_value obj, const char *key, napi_value *out,
                    napi_valuetype want) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return false;
  napi_get_named_property(env, obj, key, out);
  napi_valuetype t;
  napi_typeof(env, *out, &t);
  return t == want;
}

inline bool GetBool(napi_env env, napi_value obj, const char *key, bool *out) {
  napi_value v;
  if (!GetProp(env, obj, key, &v, napi_boolean)) return false;
  return napi_get_value_bool(env, v, out) == napi_ok;
}

inline bool GetNumber(napi_env env, napi_value obj, const char *key, double *out) {
  napi_value v;
  if (!GetProp(env, obj, key, &v, napi_number)) return false;
  return napi_get_value_double(env, v, out) == napi_ok;
}

inline bool GetString(napi_env env, napi_value obj, const char *key, NSString **out) {
  napi_value v;
  if (!GetProp(env, obj, key, &v, napi_string)) return false;
  return ValueToString(env, v, out);
}

inline void SetBool(napi_env env, napi_value obj, const char *key, bool value) {
  napi_value v;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

inline void SetNumber(napi_env env, napi_value obj, const char *key, double value) {
  napi_value v;
  napi_create_double(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

inline void SetStringOrNull(napi_env env, napi_value obj, const char *key, NSString *value) {
  napi_value v;
  if (value) {
    v = MakeString(env, value);
  } else {
    napi_get_null(env, &v);
  }
  napi_set_named_property(env, obj, key, v);
}

}  // namespace lens
