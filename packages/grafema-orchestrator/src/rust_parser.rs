//! Rust parser: .rs files -> JSON AST using the `syn` crate.
//!
//! Parses Rust source files into a JSON representation of the AST suitable for
//! Grafema's analysis pipeline. Each AST node carries a `type` discriminator,
//! a `span` with line/col locations, and type-specific fields.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::path::Path;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a Rust source file at `path` and return a JSON string of the AST.
pub fn parse_rust_file(path: &Path) -> Result<String> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read {}", path.display()))?;
    let syntax = syn::parse_file(&source)
        .map_err(|e| anyhow::anyhow!("Parse error in {}: {}", path.display(), e))?;
    let json = serialize_file(&syntax);
    serde_json::to_string(&json).context("Failed to serialize AST to JSON")
}

/// Parse Rust source text directly (useful for tests).
pub fn parse_rust_source(source: &str) -> Result<String> {
    let syntax =
        syn::parse_file(source).map_err(|e| anyhow::anyhow!("Parse error: {}", e))?;
    let json = serialize_file(&syntax);
    serde_json::to_string(&json).context("Failed to serialize AST to JSON")
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

fn serialize_span(span: proc_macro2::Span) -> Value {
    let start = span.start();
    let end = span.end();
    json!({
        "start": { "line": start.line, "col": start.column },
        "end":   { "line": end.line,   "col": end.column   }
    })
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

fn serialize_vis(vis: &syn::Visibility) -> Value {
    match vis {
        syn::Visibility::Public(_) => json!("pub"),
        syn::Visibility::Restricted(r) => {
            let path = path_to_string(&r.path);
            json!(format!("pub({})", path))
        }
        syn::Visibility::Inherited => json!(""),
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

fn path_to_string(path: &syn::Path) -> String {
    path.segments
        .iter()
        .map(|seg| seg.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

fn serialize_path(path: &syn::Path) -> Value {
    let s = path_to_string(path);
    if let Some(last) = path.segments.last() {
        match &last.arguments {
            syn::PathArguments::None => json!(s),
            syn::PathArguments::AngleBracketed(args) => {
                let type_args: Vec<Value> = args
                    .args
                    .iter()
                    .filter_map(|arg| match arg {
                        syn::GenericArgument::Type(ty) => Some(serialize_type(ty)),
                        syn::GenericArgument::Lifetime(lt) => {
                            Some(json!(format!("'{}", lt.ident)))
                        }
                        syn::GenericArgument::Const(expr) => Some(serialize_expr(expr)),
                        _ => None,
                    })
                    .collect();
                json!({"path": s, "args": type_args})
            }
            syn::PathArguments::Parenthesized(args) => {
                let inputs: Vec<Value> =
                    args.inputs.iter().map(|ty| serialize_type(ty)).collect();
                let output = match &args.output {
                    syn::ReturnType::Default => Value::Null,
                    syn::ReturnType::Type(_, ty) => serialize_type(ty),
                };
                json!({"path": s, "inputs": inputs, "output": output})
            }
        }
    } else {
        json!(s)
    }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

fn serialize_attrs(attrs: &[syn::Attribute]) -> Value {
    let items: Vec<Value> = attrs.iter().map(serialize_attr).collect();
    Value::Array(items)
}

fn serialize_attr(attr: &syn::Attribute) -> Value {
    let style = match attr.style {
        syn::AttrStyle::Outer => "outer",
        syn::AttrStyle::Inner(_) => "inner",
    };
    let path = path_to_string(attr.path());
    let tokens = match &attr.meta {
        syn::Meta::Path(_) => String::new(),
        syn::Meta::List(list) => list.tokens.to_string(),
        syn::Meta::NameValue(nv) => expr_to_token_string(&nv.value),
    };
    json!({
        "type": "Attribute",
        "style": style,
        "path": path,
        "tokens": tokens
    })
}

fn expr_to_token_string(expr: &syn::Expr) -> String {
    use quote::ToTokens;
    let mut tokens = proc_macro2::TokenStream::new();
    expr.to_tokens(&mut tokens);
    tokens.to_string()
}

// ---------------------------------------------------------------------------
// File (top-level)
// ---------------------------------------------------------------------------

fn serialize_file(file: &syn::File) -> Value {
    let items: Vec<Value> = file.items.iter().map(serialize_item).collect();
    let attrs = serialize_attrs(&file.attrs);
    json!({
        "type": "File",
        "attrs": attrs,
        "items": items
    })
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

fn serialize_item(item: &syn::Item) -> Value {
    match item {
        syn::Item::Fn(f) => serialize_item_fn(f),
        syn::Item::Struct(s) => serialize_item_struct(s),
        syn::Item::Enum(e) => serialize_item_enum(e),
        syn::Item::Impl(i) => serialize_item_impl(i),
        syn::Item::Trait(t) => serialize_item_trait(t),
        syn::Item::Mod(m) => serialize_item_mod(m),
        syn::Item::Use(u) => serialize_item_use(u),
        syn::Item::Type(t) => serialize_item_type(t),
        syn::Item::Const(c) => serialize_item_const(c),
        syn::Item::Static(s) => serialize_item_static(s),
        syn::Item::ForeignMod(fm) => serialize_item_foreign_mod(fm),
        syn::Item::Macro(m) => serialize_item_macro(m),
        syn::Item::TraitAlias(ta) => {
            json!({
                "type": "ItemTraitAlias",
                "ident": ta.ident.to_string(),
                "span": serialize_span(ta.ident.span())
            })
        }
        syn::Item::Union(u) => {
            json!({
                "type": "ItemUnion",
                "ident": u.ident.to_string(),
                "vis": serialize_vis(&u.vis),
                "fields": serialize_fields_named(&u.fields),
                "attrs": serialize_attrs(&u.attrs),
                "generics": serialize_generics(&u.generics),
                "span": serialize_span(u.ident.span())
            })
        }
        syn::Item::ExternCrate(ec) => {
            json!({
                "type": "ItemExternCrate",
                "ident": ec.ident.to_string(),
                "rename": ec.rename.as_ref().map(|(_, name)| name.to_string()),
                "vis": serialize_vis(&ec.vis),
                "span": serialize_span(ec.ident.span())
            })
        }
        _ => {
            json!({ "type": "Unknown" })
        }
    }
}

fn serialize_item_fn(f: &syn::ItemFn) -> Value {
    json!({
        "type": "ItemFn",
        "ident": f.sig.ident.to_string(),
        "vis": serialize_vis(&f.vis),
        "sig": serialize_sig(&f.sig),
        "block": serialize_block(&f.block),
        "attrs": serialize_attrs(&f.attrs),
        "span": serialize_span(f.sig.ident.span())
    })
}

fn serialize_sig(sig: &syn::Signature) -> Value {
    let inputs: Vec<Value> = sig.inputs.iter().map(serialize_fn_arg).collect();
    json!({
        "async": sig.asyncness.is_some(),
        "unsafe": sig.unsafety.is_some(),
        "const": sig.constness.is_some(),
        "inputs": inputs,
        "output": serialize_return_type(&sig.output),
        "generics": serialize_generics(&sig.generics)
    })
}

fn serialize_fn_arg(arg: &syn::FnArg) -> Value {
    match arg {
        syn::FnArg::Receiver(r) => {
            json!({
                "type": "Receiver",
                "reference": r.reference.is_some(),
                "mutability": if r.mutability.is_some() { "mut" } else { "" },
                "span": serialize_span(r.self_token.span)
            })
        }
        syn::FnArg::Typed(pt) => {
            json!({
                "type": "PatType",
                "pat": serialize_pat(&pt.pat),
                "ty": serialize_type(&pt.ty),
                "span": serialize_span(pt.colon_token.span)
            })
        }
    }
}

fn serialize_return_type(ret: &syn::ReturnType) -> Value {
    match ret {
        syn::ReturnType::Default => Value::Null,
        syn::ReturnType::Type(_, ty) => serialize_type(ty),
    }
}

fn serialize_item_struct(s: &syn::ItemStruct) -> Value {
    json!({
        "type": "ItemStruct",
        "ident": s.ident.to_string(),
        "vis": serialize_vis(&s.vis),
        "fields": serialize_fields(&s.fields),
        "attrs": serialize_attrs(&s.attrs),
        "generics": serialize_generics(&s.generics),
        "span": serialize_span(s.ident.span())
    })
}

fn serialize_fields(fields: &syn::Fields) -> Value {
    match fields {
        syn::Fields::Named(named) => serialize_fields_named(named),
        syn::Fields::Unnamed(unnamed) => {
            let items: Vec<Value> = unnamed
                .unnamed
                .iter()
                .map(|f| {
                    json!({
                        "ty": serialize_type(&f.ty),
                        "vis": serialize_vis(&f.vis),
                        "attrs": serialize_attrs(&f.attrs),
                        "span": serialize_span(type_span(&f.ty))
                    })
                })
                .collect();
            Value::Array(items)
        }
        syn::Fields::Unit => Value::Array(vec![]),
    }
}

fn serialize_fields_named(named: &syn::FieldsNamed) -> Value {
    let items: Vec<Value> = named
        .named
        .iter()
        .map(|f| {
            let span = f
                .ident
                .as_ref()
                .map(|i| i.span())
                .unwrap_or_else(|| type_span(&f.ty));
            json!({
                "ident": f.ident.as_ref().map(|i| i.to_string()),
                "ty": serialize_type(&f.ty),
                "vis": serialize_vis(&f.vis),
                "attrs": serialize_attrs(&f.attrs),
                "span": serialize_span(span)
            })
        })
        .collect();
    Value::Array(items)
}

fn serialize_item_enum(e: &syn::ItemEnum) -> Value {
    let variants: Vec<Value> = e
        .variants
        .iter()
        .map(|v| {
            json!({
                "ident": v.ident.to_string(),
                "fields": serialize_fields(&v.fields),
                "discriminant": v.discriminant.as_ref().map(|(_, expr)| serialize_expr(expr)),
                "attrs": serialize_attrs(&v.attrs),
                "span": serialize_span(v.ident.span())
            })
        })
        .collect();
    json!({
        "type": "ItemEnum",
        "ident": e.ident.to_string(),
        "vis": serialize_vis(&e.vis),
        "variants": variants,
        "attrs": serialize_attrs(&e.attrs),
        "generics": serialize_generics(&e.generics),
        "span": serialize_span(e.ident.span())
    })
}

fn serialize_item_impl(i: &syn::ItemImpl) -> Value {
    let items: Vec<Value> = i.items.iter().map(serialize_impl_item).collect();
    let trait_ = i.trait_.as_ref().map(|(bang, path, _)| {
        let mut v = json!({"path": serialize_path(path)});
        if bang.is_some() {
            v["negated"] = json!(true);
        }
        v
    });
    json!({
        "type": "ItemImpl",
        "self_ty": serialize_type(&i.self_ty),
        "trait_": trait_,
        "items": items,
        "generics": serialize_generics(&i.generics),
        "attrs": serialize_attrs(&i.attrs),
        "span": serialize_span(i.impl_token.span)
    })
}

fn serialize_impl_item(item: &syn::ImplItem) -> Value {
    match item {
        syn::ImplItem::Fn(m) => {
            json!({
                "type": "ImplItemFn",
                "ident": m.sig.ident.to_string(),
                "vis": serialize_vis(&m.vis),
                "sig": serialize_sig(&m.sig),
                "block": serialize_block(&m.block),
                "attrs": serialize_attrs(&m.attrs),
                "span": serialize_span(m.sig.ident.span())
            })
        }
        syn::ImplItem::Const(c) => {
            json!({
                "type": "ImplItemConst",
                "ident": c.ident.to_string(),
                "ty": serialize_type(&c.ty),
                "expr": serialize_expr(&c.expr),
                "span": serialize_span(c.ident.span())
            })
        }
        syn::ImplItem::Type(t) => {
            json!({
                "type": "ImplItemType",
                "ident": t.ident.to_string(),
                "ty": serialize_type(&t.ty),
                "span": serialize_span(t.ident.span())
            })
        }
        syn::ImplItem::Macro(m) => {
            json!({
                "type": "ImplItemMacro",
                "mac": serialize_macro(&m.mac),
                "span": serialize_span(macro_span(&m.mac))
            })
        }
        _ => json!({"type": "Unknown"}),
    }
}

fn serialize_item_trait(t: &syn::ItemTrait) -> Value {
    let items: Vec<Value> = t.items.iter().map(serialize_trait_item).collect();
    let supertraits: Vec<Value> = t
        .supertraits
        .iter()
        .map(serialize_type_param_bound)
        .collect();
    json!({
        "type": "ItemTrait",
        "ident": t.ident.to_string(),
        "vis": serialize_vis(&t.vis),
        "items": items,
        "supertraits": supertraits,
        "attrs": serialize_attrs(&t.attrs),
        "generics": serialize_generics(&t.generics),
        "span": serialize_span(t.ident.span())
    })
}

fn serialize_trait_item(item: &syn::TraitItem) -> Value {
    match item {
        syn::TraitItem::Fn(m) => {
            let default = m.default.as_ref().map(serialize_block);
            json!({
                "type": "TraitItemFn",
                "ident": m.sig.ident.to_string(),
                "sig": serialize_sig(&m.sig),
                "default": default,
                "attrs": serialize_attrs(&m.attrs),
                "span": serialize_span(m.sig.ident.span())
            })
        }
        syn::TraitItem::Const(c) => {
            json!({
                "type": "TraitItemConst",
                "ident": c.ident.to_string(),
                "ty": serialize_type(&c.ty),
                "default": c.default.as_ref().map(|(_, expr)| serialize_expr(expr)),
                "span": serialize_span(c.ident.span())
            })
        }
        syn::TraitItem::Type(t) => {
            let bounds: Vec<Value> = t
                .bounds
                .iter()
                .map(serialize_type_param_bound)
                .collect();
            json!({
                "type": "TraitItemType",
                "ident": t.ident.to_string(),
                "bounds": bounds,
                "default": t.default.as_ref().map(|(_, ty)| serialize_type(ty)),
                "span": serialize_span(t.ident.span())
            })
        }
        syn::TraitItem::Macro(m) => {
            json!({
                "type": "TraitItemMacro",
                "mac": serialize_macro(&m.mac),
                "span": serialize_span(macro_span(&m.mac))
            })
        }
        _ => json!({"type": "Unknown"}),
    }
}

fn serialize_item_mod(m: &syn::ItemMod) -> Value {
    let content = m.content.as_ref().map(|(_, items)| {
        let serialized: Vec<Value> = items.iter().map(serialize_item).collect();
        Value::Array(serialized)
    });
    json!({
        "type": "ItemMod",
        "ident": m.ident.to_string(),
        "vis": serialize_vis(&m.vis),
        "content": content,
        "attrs": serialize_attrs(&m.attrs),
        "span": serialize_span(m.ident.span())
    })
}

fn serialize_item_use(u: &syn::ItemUse) -> Value {
    json!({
        "type": "ItemUse",
        "tree": serialize_use_tree(&u.tree),
        "vis": serialize_vis(&u.vis),
        "attrs": serialize_attrs(&u.attrs),
        "span": serialize_span(u.use_token.span)
    })
}

fn serialize_use_tree(tree: &syn::UseTree) -> Value {
    match tree {
        syn::UseTree::Path(p) => {
            json!({
                "type": "UsePath",
                "ident": p.ident.to_string(),
                "tree": serialize_use_tree(&p.tree)
            })
        }
        syn::UseTree::Name(n) => {
            json!({
                "type": "UseName",
                "ident": n.ident.to_string()
            })
        }
        syn::UseTree::Rename(r) => {
            json!({
                "type": "UseRename",
                "ident": r.ident.to_string(),
                "rename": r.rename.to_string()
            })
        }
        syn::UseTree::Glob(_) => {
            json!({"type": "UseGlob"})
        }
        syn::UseTree::Group(g) => {
            let items: Vec<Value> = g.items.iter().map(serialize_use_tree).collect();
            json!({
                "type": "UseGroup",
                "items": items
            })
        }
    }
}

fn serialize_item_type(t: &syn::ItemType) -> Value {
    json!({
        "type": "ItemType",
        "ident": t.ident.to_string(),
        "vis": serialize_vis(&t.vis),
        "ty": serialize_type(&t.ty),
        "generics": serialize_generics(&t.generics),
        "attrs": serialize_attrs(&t.attrs),
        "span": serialize_span(t.ident.span())
    })
}

fn serialize_item_const(c: &syn::ItemConst) -> Value {
    json!({
        "type": "ItemConst",
        "ident": c.ident.to_string(),
        "vis": serialize_vis(&c.vis),
        "ty": serialize_type(&c.ty),
        "expr": serialize_expr(&c.expr),
        "attrs": serialize_attrs(&c.attrs),
        "span": serialize_span(c.ident.span())
    })
}

fn serialize_item_static(s: &syn::ItemStatic) -> Value {
    json!({
        "type": "ItemStatic",
        "ident": s.ident.to_string(),
        "vis": serialize_vis(&s.vis),
        "ty": serialize_type(&s.ty),
        "mutability": serialize_static_mutability(&s.mutability),
        "expr": serialize_expr(&s.expr),
        "attrs": serialize_attrs(&s.attrs),
        "span": serialize_span(s.ident.span())
    })
}

fn serialize_static_mutability(m: &syn::StaticMutability) -> Value {
    match m {
        syn::StaticMutability::Mut(_) => json!("mut"),
        syn::StaticMutability::None => json!(""),
        _ => json!(""),
    }
}

fn serialize_item_foreign_mod(fm: &syn::ItemForeignMod) -> Value {
    let items: Vec<Value> = fm
        .items
        .iter()
        .map(|item| match item {
            syn::ForeignItem::Fn(f) => {
                json!({
                    "type": "ForeignItemFn",
                    "ident": f.sig.ident.to_string(),
                    "vis": serialize_vis(&f.vis),
                    "sig": serialize_sig(&f.sig),
                    "attrs": serialize_attrs(&f.attrs),
                    "span": serialize_span(f.sig.ident.span())
                })
            }
            syn::ForeignItem::Static(s) => {
                json!({
                    "type": "ForeignItemStatic",
                    "ident": s.ident.to_string(),
                    "vis": serialize_vis(&s.vis),
                    "ty": serialize_type(&s.ty),
                    "mutability": serialize_static_mutability(&s.mutability),
                    "span": serialize_span(s.ident.span())
                })
            }
            syn::ForeignItem::Type(t) => {
                json!({
                    "type": "ForeignItemType",
                    "ident": t.ident.to_string(),
                    "vis": serialize_vis(&t.vis),
                    "span": serialize_span(t.ident.span())
                })
            }
            syn::ForeignItem::Macro(m) => {
                json!({
                    "type": "ForeignItemMacro",
                    "mac": serialize_macro(&m.mac),
                    "span": serialize_span(macro_span(&m.mac))
                })
            }
            _ => json!({"type": "Unknown"}),
        })
        .collect();
    let abi = fm
        .abi
        .name
        .as_ref()
        .map(|lit| lit.value())
        .unwrap_or_default();
    json!({
        "type": "ItemForeignMod",
        "abi": abi,
        "items": items,
        "attrs": serialize_attrs(&fm.attrs),
        "span": serialize_span(fm.abi.extern_token.span)
    })
}

fn serialize_item_macro(m: &syn::ItemMacro) -> Value {
    json!({
        "type": "ItemMacro",
        "ident": m.ident.as_ref().map(|i| i.to_string()),
        "mac": serialize_macro(&m.mac),
        "attrs": serialize_attrs(&m.attrs),
        "span": serialize_span(macro_span(&m.mac))
    })
}

fn serialize_macro(mac: &syn::Macro) -> Value {
    json!({
        "path": path_to_string(&mac.path),
        "tokens": mac.tokens.to_string()
    })
}

/// Get the span for a macro invocation.
fn macro_span(mac: &syn::Macro) -> proc_macro2::Span {
    mac.path
        .segments
        .first()
        .map(|s| s.ident.span())
        .unwrap_or_else(proc_macro2::Span::call_site)
}

// ---------------------------------------------------------------------------
// Generics
// ---------------------------------------------------------------------------

fn serialize_generics(generics: &syn::Generics) -> Value {
    let params: Vec<Value> = generics
        .params
        .iter()
        .map(|p| match p {
            syn::GenericParam::Lifetime(lt) => {
                json!({
                    "type": "Lifetime",
                    "ident": format!("'{}", lt.lifetime.ident)
                })
            }
            syn::GenericParam::Type(tp) => {
                let bounds: Vec<Value> = tp
                    .bounds
                    .iter()
                    .map(serialize_type_param_bound)
                    .collect();
                json!({
                    "type": "TypeParam",
                    "ident": tp.ident.to_string(),
                    "bounds": bounds,
                    "default": tp.default.as_ref().map(serialize_type)
                })
            }
            syn::GenericParam::Const(cp) => {
                json!({
                    "type": "ConstParam",
                    "ident": cp.ident.to_string(),
                    "ty": serialize_type(&cp.ty)
                })
            }
        })
        .collect();

    let where_clause = generics.where_clause.as_ref().map(|wc| {
        let predicates: Vec<Value> = wc
            .predicates
            .iter()
            .map(|pred| match pred {
                syn::WherePredicate::Type(pt) => {
                    let bounds: Vec<Value> = pt
                        .bounds
                        .iter()
                        .map(serialize_type_param_bound)
                        .collect();
                    json!({
                        "type": "PredicateType",
                        "bounded_ty": serialize_type(&pt.bounded_ty),
                        "bounds": bounds
                    })
                }
                syn::WherePredicate::Lifetime(lt) => {
                    let bounds: Vec<Value> = lt
                        .bounds
                        .iter()
                        .map(|b| json!(format!("'{}", b.ident)))
                        .collect();
                    json!({
                        "type": "PredicateLifetime",
                        "lifetime": format!("'{}", lt.lifetime.ident),
                        "bounds": bounds
                    })
                }
                _ => json!({"type": "Unknown"}),
            })
            .collect();
        Value::Array(predicates)
    });

    json!({
        "params": params,
        "where_clause": where_clause
    })
}

fn serialize_type_param_bound(bound: &syn::TypeParamBound) -> Value {
    match bound {
        syn::TypeParamBound::Trait(tb) => {
            json!({
                "type": "TraitBound",
                "path": serialize_path(&tb.path),
                "modifier": match tb.modifier {
                    syn::TraitBoundModifier::None => "",
                    syn::TraitBoundModifier::Maybe(_) => "?",
                }
            })
        }
        syn::TypeParamBound::Lifetime(lt) => {
            json!({
                "type": "Lifetime",
                "ident": format!("'{}", lt.ident)
            })
        }
        _ => json!({"type": "Unknown"}),
    }
}

// ---------------------------------------------------------------------------
// Block & Statements
// ---------------------------------------------------------------------------

fn serialize_block(block: &syn::Block) -> Value {
    let stmts: Vec<Value> = block.stmts.iter().map(serialize_stmt).collect();
    json!({
        "type": "ExprBlock",
        "stmts": stmts,
        "span": serialize_span(block.brace_token.span.join())
    })
}

fn serialize_stmt(stmt: &syn::Stmt) -> Value {
    match stmt {
        syn::Stmt::Local(local) => {
            let init = local.init.as_ref().map(|li| serialize_expr(&li.expr));
            json!({
                "type": "StmtLocal",
                "pat": serialize_pat(&local.pat),
                "init": init,
                "attrs": serialize_attrs(&local.attrs),
                "span": serialize_span(local.let_token.span)
            })
        }
        syn::Stmt::Item(item) => serialize_item(item),
        syn::Stmt::Expr(expr, semi) => {
            let mut v = serialize_expr(expr);
            if semi.is_some() {
                if let Value::Object(ref mut map) = v {
                    map.insert("semi".to_string(), json!(true));
                }
            }
            v
        }
        syn::Stmt::Macro(m) => {
            json!({
                "type": "StmtMacro",
                "mac": serialize_macro(&m.mac),
                "semi": m.semi_token.is_some(),
                "attrs": serialize_attrs(&m.attrs),
                "span": serialize_span(macro_span(&m.mac))
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

fn serialize_expr(expr: &syn::Expr) -> Value {
    match expr {
        syn::Expr::Call(e) => {
            let args: Vec<Value> = e.args.iter().map(serialize_expr).collect();
            json!({
                "type": "ExprCall",
                "func": serialize_expr(&e.func),
                "args": args,
                "span": serialize_span(e.paren_token.span.join())
            })
        }
        syn::Expr::MethodCall(e) => {
            let args: Vec<Value> = e.args.iter().map(serialize_expr).collect();
            json!({
                "type": "ExprMethodCall",
                "receiver": serialize_expr(&e.receiver),
                "method": e.method.to_string(),
                "args": args,
                "span": serialize_span(e.method.span())
            })
        }
        syn::Expr::Binary(e) => {
            json!({
                "type": "ExprBinary",
                "left": serialize_expr(&e.left),
                "op": serialize_binop(&e.op),
                "right": serialize_expr(&e.right),
                "span": serialize_span(binop_span(&e.op))
            })
        }
        syn::Expr::Unary(e) => {
            json!({
                "type": "ExprUnary",
                "op": serialize_unop(&e.op),
                "expr": serialize_expr(&e.expr),
                "span": serialize_span(unop_span(&e.op))
            })
        }
        syn::Expr::Block(e) => serialize_block(&e.block),
        syn::Expr::If(e) => {
            json!({
                "type": "ExprIf",
                "cond": serialize_expr(&e.cond),
                "then_branch": serialize_block(&e.then_branch),
                "else_branch": e.else_branch.as_ref().map(|(_, expr)| serialize_expr(expr)),
                "span": serialize_span(e.if_token.span)
            })
        }
        syn::Expr::Match(e) => {
            let arms: Vec<Value> = e
                .arms
                .iter()
                .map(|arm| {
                    json!({
                        "pat": serialize_pat(&arm.pat),
                        "guard": arm.guard.as_ref().map(|(_, expr)| serialize_expr(expr)),
                        "body": serialize_expr(&arm.body),
                        "span": serialize_span(arm.fat_arrow_token.spans[0])
                    })
                })
                .collect();
            json!({
                "type": "ExprMatch",
                "expr": serialize_expr(&e.expr),
                "arms": arms,
                "span": serialize_span(e.match_token.span)
            })
        }
        syn::Expr::Loop(e) => {
            json!({
                "type": "ExprLoop",
                "body": serialize_block(&e.body),
                "label": e.label.as_ref().map(|l| l.name.ident.to_string()),
                "span": serialize_span(e.loop_token.span)
            })
        }
        syn::Expr::While(e) => {
            json!({
                "type": "ExprWhile",
                "cond": serialize_expr(&e.cond),
                "body": serialize_block(&e.body),
                "label": e.label.as_ref().map(|l| l.name.ident.to_string()),
                "span": serialize_span(e.while_token.span)
            })
        }
        syn::Expr::ForLoop(e) => {
            json!({
                "type": "ExprForLoop",
                "pat": serialize_pat(&e.pat),
                "expr": serialize_expr(&e.expr),
                "body": serialize_block(&e.body),
                "label": e.label.as_ref().map(|l| l.name.ident.to_string()),
                "span": serialize_span(e.for_token.span)
            })
        }
        syn::Expr::Return(e) => {
            json!({
                "type": "ExprReturn",
                "expr": e.expr.as_ref().map(|expr| serialize_expr(expr)),
                "span": serialize_span(e.return_token.span)
            })
        }
        syn::Expr::Break(e) => {
            json!({
                "type": "ExprBreak",
                "expr": e.expr.as_ref().map(|expr| serialize_expr(expr)),
                "label": e.label.as_ref().map(|l| l.ident.to_string()),
                "span": serialize_span(e.break_token.span)
            })
        }
        syn::Expr::Continue(e) => {
            json!({
                "type": "ExprContinue",
                "label": e.label.as_ref().map(|l| l.ident.to_string()),
                "span": serialize_span(e.continue_token.span)
            })
        }
        syn::Expr::Closure(e) => {
            let inputs: Vec<Value> = e.inputs.iter().map(serialize_pat).collect();
            json!({
                "type": "ExprClosure",
                "inputs": inputs,
                "output": serialize_return_type(&e.output),
                "body": serialize_expr(&e.body),
                "capture": if e.capture.is_some() { "move" } else { "" },
                "span": serialize_span(e.or1_token.span)
            })
        }
        syn::Expr::Field(e) => {
            let member = match &e.member {
                syn::Member::Named(ident) => json!(ident.to_string()),
                syn::Member::Unnamed(index) => json!(index.index),
            };
            json!({
                "type": "ExprField",
                "base": serialize_expr(&e.base),
                "member": member,
                "span": serialize_span(e.dot_token.span)
            })
        }
        syn::Expr::Index(e) => {
            json!({
                "type": "ExprIndex",
                "expr": serialize_expr(&e.expr),
                "index": serialize_expr(&e.index),
                "span": serialize_span(e.bracket_token.span.join())
            })
        }
        syn::Expr::Path(e) => {
            json!({
                "type": "ExprPath",
                "path": path_to_string(&e.path),
                "span": serialize_span(
                    e.path.segments.last()
                        .map(|s| s.ident.span())
                        .unwrap_or_else(proc_macro2::Span::call_site)
                )
            })
        }
        syn::Expr::Reference(e) => {
            json!({
                "type": "ExprReference",
                "expr": serialize_expr(&e.expr),
                "mutability": if e.mutability.is_some() { "mut" } else { "" },
                "span": serialize_span(e.and_token.span)
            })
        }
        syn::Expr::Struct(e) => {
            let fields: Vec<Value> = e
                .fields
                .iter()
                .map(|f| {
                    json!({
                        "member": match &f.member {
                            syn::Member::Named(ident) => json!(ident.to_string()),
                            syn::Member::Unnamed(index) => json!(index.index),
                        },
                        "expr": serialize_expr(&f.expr)
                    })
                })
                .collect();
            json!({
                "type": "ExprStruct",
                "path": serialize_path(&e.path),
                "fields": fields,
                "rest": e.rest.as_ref().map(|r| serialize_expr(r)),
                "span": serialize_span(e.brace_token.span.join())
            })
        }
        syn::Expr::Tuple(e) => {
            let elems: Vec<Value> = e.elems.iter().map(serialize_expr).collect();
            json!({
                "type": "ExprTuple",
                "elems": elems,
                "span": serialize_span(e.paren_token.span.join())
            })
        }
        syn::Expr::Array(e) => {
            let elems: Vec<Value> = e.elems.iter().map(serialize_expr).collect();
            json!({
                "type": "ExprArray",
                "elems": elems,
                "span": serialize_span(e.bracket_token.span.join())
            })
        }
        syn::Expr::Range(e) => {
            json!({
                "type": "ExprRange",
                "start": e.start.as_ref().map(|expr| serialize_expr(expr)),
                "end": e.end.as_ref().map(|expr| serialize_expr(expr)),
                "span": serialize_span(range_limits_span(&e.limits))
            })
        }
        syn::Expr::Await(e) => {
            json!({
                "type": "ExprAwait",
                "base": serialize_expr(&e.base),
                "span": serialize_span(e.await_token.span)
            })
        }
        syn::Expr::Async(e) => {
            json!({
                "type": "ExprAsync",
                "capture": if e.capture.is_some() { "move" } else { "" },
                "block": serialize_block(&e.block),
                "span": serialize_span(e.async_token.span)
            })
        }
        syn::Expr::Try(e) => {
            json!({
                "type": "ExprTry",
                "expr": serialize_expr(&e.expr),
                "span": serialize_span(e.question_token.span)
            })
        }
        syn::Expr::Let(e) => {
            json!({
                "type": "ExprLet",
                "pat": serialize_pat(&e.pat),
                "expr": serialize_expr(&e.expr),
                "span": serialize_span(e.let_token.span)
            })
        }
        syn::Expr::Assign(e) => {
            json!({
                "type": "ExprAssign",
                "left": serialize_expr(&e.left),
                "right": serialize_expr(&e.right),
                "span": serialize_span(e.eq_token.span)
            })
        }
        syn::Expr::Unsafe(e) => {
            json!({
                "type": "ExprUnsafe",
                "block": serialize_block(&e.block),
                "span": serialize_span(e.unsafe_token.span)
            })
        }
        syn::Expr::Lit(e) => {
            json!({
                "type": "ExprLit",
                "lit": serialize_lit(&e.lit),
                "span": serialize_span(lit_span(&e.lit))
            })
        }
        syn::Expr::Cast(e) => {
            json!({
                "type": "ExprCast",
                "expr": serialize_expr(&e.expr),
                "ty": serialize_type(&e.ty),
                "span": serialize_span(e.as_token.span)
            })
        }
        syn::Expr::Paren(e) => serialize_expr(&e.expr),
        syn::Expr::Group(e) => serialize_expr(&e.expr),
        syn::Expr::Repeat(e) => {
            json!({
                "type": "ExprRepeat",
                "expr": serialize_expr(&e.expr),
                "len": serialize_expr(&e.len),
                "span": serialize_span(e.bracket_token.span.join())
            })
        }
        syn::Expr::Yield(e) => {
            json!({
                "type": "ExprYield",
                "expr": e.expr.as_ref().map(|expr| serialize_expr(expr)),
                "span": serialize_span(e.yield_token.span)
            })
        }
        syn::Expr::Macro(e) => {
            json!({
                "type": "ExprMacro",
                "mac": serialize_macro(&e.mac),
                "span": serialize_span(macro_span(&e.mac))
            })
        }
        syn::Expr::Const(e) => {
            json!({
                "type": "ExprConst",
                "block": serialize_block(&e.block),
                "span": serialize_span(e.const_token.span)
            })
        }
        syn::Expr::Infer(_) => {
            json!({ "type": "ExprInfer" })
        }
        syn::Expr::Verbatim(tokens) => {
            json!({
                "type": "ExprVerbatim",
                "tokens": tokens.to_string()
            })
        }
        _ => {
            json!({ "type": "Unknown" })
        }
    }
}

fn serialize_lit(lit: &syn::Lit) -> Value {
    match lit {
        syn::Lit::Str(s) => json!({"type": "Str", "value": s.value()}),
        syn::Lit::ByteStr(s) => json!({"type": "ByteStr", "value": format!("{:?}", s.value())}),
        syn::Lit::CStr(s) => json!({"type": "CStr", "value": format!("{:?}", s.value())}),
        syn::Lit::Byte(b) => json!({"type": "Byte", "value": b.value()}),
        syn::Lit::Char(c) => json!({"type": "Char", "value": c.value().to_string()}),
        syn::Lit::Int(i) => json!({"type": "Int", "value": i.base10_digits()}),
        syn::Lit::Float(f) => json!({"type": "Float", "value": f.base10_digits()}),
        syn::Lit::Bool(b) => json!({"type": "Bool", "value": b.value}),
        syn::Lit::Verbatim(v) => json!({"type": "Verbatim", "value": v.to_string()}),
        _ => json!({"type": "Unknown"}),
    }
}

fn serialize_binop(op: &syn::BinOp) -> Value {
    let s = match op {
        syn::BinOp::Add(_) => "+",
        syn::BinOp::Sub(_) => "-",
        syn::BinOp::Mul(_) => "*",
        syn::BinOp::Div(_) => "/",
        syn::BinOp::Rem(_) => "%",
        syn::BinOp::And(_) => "&&",
        syn::BinOp::Or(_) => "||",
        syn::BinOp::BitXor(_) => "^",
        syn::BinOp::BitAnd(_) => "&",
        syn::BinOp::BitOr(_) => "|",
        syn::BinOp::Shl(_) => "<<",
        syn::BinOp::Shr(_) => ">>",
        syn::BinOp::Eq(_) => "==",
        syn::BinOp::Lt(_) => "<",
        syn::BinOp::Le(_) => "<=",
        syn::BinOp::Ne(_) => "!=",
        syn::BinOp::Ge(_) => ">=",
        syn::BinOp::Gt(_) => ">",
        syn::BinOp::AddAssign(_) => "+=",
        syn::BinOp::SubAssign(_) => "-=",
        syn::BinOp::MulAssign(_) => "*=",
        syn::BinOp::DivAssign(_) => "/=",
        syn::BinOp::RemAssign(_) => "%=",
        syn::BinOp::BitXorAssign(_) => "^=",
        syn::BinOp::BitAndAssign(_) => "&=",
        syn::BinOp::BitOrAssign(_) => "|=",
        syn::BinOp::ShlAssign(_) => "<<=",
        syn::BinOp::ShrAssign(_) => ">>=",
        _ => "?",
    };
    json!(s)
}

fn serialize_unop(op: &syn::UnOp) -> Value {
    let s = match op {
        syn::UnOp::Deref(_) => "*",
        syn::UnOp::Not(_) => "!",
        syn::UnOp::Neg(_) => "-",
        _ => "?",
    };
    json!(s)
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

fn serialize_pat(pat: &syn::Pat) -> Value {
    match pat {
        syn::Pat::Ident(p) => {
            json!({
                "type": "PatIdent",
                "ident": p.ident.to_string(),
                "mutability": if p.mutability.is_some() { "mut" } else { "" },
                "by_ref": p.by_ref.is_some(),
                "subpat": p.subpat.as_ref().map(|(_, pat)| serialize_pat(pat)),
                "span": serialize_span(p.ident.span())
            })
        }
        syn::Pat::Struct(p) => {
            let fields: Vec<Value> = p
                .fields
                .iter()
                .map(|f| {
                    json!({
                        "member": match &f.member {
                            syn::Member::Named(ident) => json!(ident.to_string()),
                            syn::Member::Unnamed(index) => json!(index.index),
                        },
                        "pat": serialize_pat(&f.pat)
                    })
                })
                .collect();
            json!({
                "type": "PatStruct",
                "path": serialize_path(&p.path),
                "fields": fields,
                "rest": p.rest.is_some(),
                "span": serialize_span(p.brace_token.span.join())
            })
        }
        syn::Pat::TupleStruct(p) => {
            let elems: Vec<Value> = p.elems.iter().map(serialize_pat).collect();
            json!({
                "type": "PatTupleStruct",
                "path": serialize_path(&p.path),
                "elems": elems,
                "span": serialize_span(p.paren_token.span.join())
            })
        }
        syn::Pat::Tuple(p) => {
            let elems: Vec<Value> = p.elems.iter().map(serialize_pat).collect();
            json!({
                "type": "PatTuple",
                "elems": elems,
                "span": serialize_span(p.paren_token.span.join())
            })
        }
        syn::Pat::Path(p) => {
            json!({
                "type": "PatPath",
                "path": serialize_path(&p.path),
                "span": serialize_span(
                    p.path.segments.last()
                        .map(|s| s.ident.span())
                        .unwrap_or_else(proc_macro2::Span::call_site)
                )
            })
        }
        syn::Pat::Wild(p) => {
            json!({
                "type": "PatWild",
                "span": serialize_span(p.underscore_token.span)
            })
        }
        syn::Pat::Or(p) => {
            let cases: Vec<Value> = p.cases.iter().map(serialize_pat).collect();
            json!({
                "type": "PatOr",
                "cases": cases,
                "span": serialize_span(
                    p.leading_vert.map(|v| v.span)
                        .unwrap_or_else(proc_macro2::Span::call_site)
                )
            })
        }
        syn::Pat::Range(p) => {
            json!({
                "type": "PatRange",
                "start": p.start.as_ref().map(|e| serialize_expr(e)),
                "end": p.end.as_ref().map(|e| serialize_expr(e)),
                "span": serialize_span(range_limits_span(&p.limits))
            })
        }
        syn::Pat::Reference(p) => {
            json!({
                "type": "PatReference",
                "pat": serialize_pat(&p.pat),
                "mutability": if p.mutability.is_some() { "mut" } else { "" },
                "span": serialize_span(p.and_token.span)
            })
        }
        syn::Pat::Slice(p) => {
            let elems: Vec<Value> = p.elems.iter().map(serialize_pat).collect();
            json!({
                "type": "PatSlice",
                "elems": elems,
                "span": serialize_span(p.bracket_token.span.join())
            })
        }
        syn::Pat::Lit(p) => {
            json!({
                "type": "PatLit",
                "lit": serialize_lit(&p.lit),
                "span": serialize_span(lit_span(&p.lit))
            })
        }
        syn::Pat::Rest(p) => {
            json!({
                "type": "PatRest",
                "span": serialize_span(p.dot2_token.spans[0])
            })
        }
        syn::Pat::Paren(p) => serialize_pat(&p.pat),
        syn::Pat::Macro(p) => {
            json!({
                "type": "PatMacro",
                "mac": serialize_macro(&p.mac),
                "span": serialize_span(macro_span(&p.mac))
            })
        }
        syn::Pat::Type(p) => {
            json!({
                "type": "PatType",
                "pat": serialize_pat(&p.pat),
                "ty": serialize_type(&p.ty),
                "span": serialize_span(p.colon_token.span)
            })
        }
        syn::Pat::Const(p) => {
            json!({
                "type": "PatConst",
                "block": serialize_block(&p.block),
                "span": serialize_span(p.const_token.span)
            })
        }
        _ => json!({"type": "Unknown"}),
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

fn serialize_type(ty: &syn::Type) -> Value {
    match ty {
        syn::Type::Path(t) => {
            let path_str = t
                .path
                .segments
                .iter()
                .map(|seg| seg.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            let args: Vec<Value> = t
                .path
                .segments
                .last()
                .map(|seg| match &seg.arguments {
                    syn::PathArguments::AngleBracketed(ab) => ab
                        .args
                        .iter()
                        .filter_map(|arg| match arg {
                            syn::GenericArgument::Type(ty) => Some(serialize_type(ty)),
                            syn::GenericArgument::Lifetime(lt) => {
                                Some(json!(format!("'{}", lt.ident)))
                            }
                            syn::GenericArgument::Const(expr) => Some(serialize_expr(expr)),
                            _ => None,
                        })
                        .collect(),
                    _ => vec![],
                })
                .unwrap_or_default();
            let span = t
                .path
                .segments
                .last()
                .map(|s| s.ident.span())
                .unwrap_or_else(proc_macro2::Span::call_site);
            if args.is_empty() {
                json!({
                    "type": "TypePath",
                    "path": path_str,
                    "span": serialize_span(span)
                })
            } else {
                json!({
                    "type": "TypePath",
                    "path": path_str,
                    "args": args,
                    "span": serialize_span(span)
                })
            }
        }
        syn::Type::Reference(t) => {
            json!({
                "type": "TypeReference",
                "lifetime": t.lifetime.as_ref().map(|lt| format!("'{}", lt.ident)),
                "mutability": if t.mutability.is_some() { "mut" } else { "" },
                "elem": serialize_type(&t.elem),
                "span": serialize_span(t.and_token.span)
            })
        }
        syn::Type::Slice(t) => {
            json!({
                "type": "TypeSlice",
                "elem": serialize_type(&t.elem),
                "span": serialize_span(t.bracket_token.span.join())
            })
        }
        syn::Type::Array(t) => {
            json!({
                "type": "TypeArray",
                "elem": serialize_type(&t.elem),
                "len": serialize_expr(&t.len),
                "span": serialize_span(t.bracket_token.span.join())
            })
        }
        syn::Type::Tuple(t) => {
            let elems: Vec<Value> = t.elems.iter().map(serialize_type).collect();
            json!({
                "type": "TypeTuple",
                "elems": elems,
                "span": serialize_span(t.paren_token.span.join())
            })
        }
        syn::Type::BareFn(t) => {
            let inputs: Vec<Value> = t
                .inputs
                .iter()
                .map(|arg| {
                    json!({
                        "name": arg.name.as_ref().map(|(ident, _)| ident.to_string()),
                        "ty": serialize_type(&arg.ty)
                    })
                })
                .collect();
            let output = match &t.output {
                syn::ReturnType::Default => Value::Null,
                syn::ReturnType::Type(_, ty) => serialize_type(ty),
            };
            json!({
                "type": "TypeFn",
                "inputs": inputs,
                "output": output,
                "span": serialize_span(t.fn_token.span)
            })
        }
        syn::Type::ImplTrait(t) => {
            let bounds: Vec<Value> = t
                .bounds
                .iter()
                .map(serialize_type_param_bound)
                .collect();
            json!({
                "type": "TypeImplTrait",
                "bounds": bounds,
                "span": serialize_span(t.impl_token.span)
            })
        }
        syn::Type::TraitObject(t) => {
            let bounds: Vec<Value> = t
                .bounds
                .iter()
                .map(serialize_type_param_bound)
                .collect();
            json!({
                "type": "TypeTraitObject",
                "bounds": bounds,
                "span": serialize_span(t.dyn_token
                    .map(|d| d.span)
                    .unwrap_or_else(proc_macro2::Span::call_site))
            })
        }
        syn::Type::Never(t) => {
            json!({
                "type": "TypeNever",
                "span": serialize_span(t.bang_token.span)
            })
        }
        syn::Type::Ptr(t) => {
            json!({
                "type": "TypePtr",
                "mutability": if t.mutability.is_some() { "mut" } else { "const" },
                "elem": serialize_type(&t.elem),
                "span": serialize_span(t.star_token.span)
            })
        }
        syn::Type::Paren(t) => serialize_type(&t.elem),
        syn::Type::Group(t) => serialize_type(&t.elem),
        syn::Type::Infer(t) => {
            json!({
                "type": "TypeInfer",
                "span": serialize_span(t.underscore_token.span)
            })
        }
        syn::Type::Macro(t) => {
            json!({
                "type": "TypeMacro",
                "mac": serialize_macro(&t.mac),
                "span": serialize_span(macro_span(&t.mac))
            })
        }
        syn::Type::Verbatim(tokens) => {
            json!({
                "type": "TypeVerbatim",
                "tokens": tokens.to_string()
            })
        }
        _ => json!({"type": "Unknown"}),
    }
}

// ---------------------------------------------------------------------------
// Span helpers for operator tokens and other nodes
// ---------------------------------------------------------------------------

fn binop_span(op: &syn::BinOp) -> proc_macro2::Span {
    match op {
        syn::BinOp::Add(t) => t.span,
        syn::BinOp::Sub(t) => t.span,
        syn::BinOp::Mul(t) => t.span,
        syn::BinOp::Div(t) => t.span,
        syn::BinOp::Rem(t) => t.span,
        syn::BinOp::And(t) => t.spans[0],
        syn::BinOp::Or(t) => t.spans[0],
        syn::BinOp::BitXor(t) => t.span,
        syn::BinOp::BitAnd(t) => t.span,
        syn::BinOp::BitOr(t) => t.span,
        syn::BinOp::Shl(t) => t.spans[0],
        syn::BinOp::Shr(t) => t.spans[0],
        syn::BinOp::Eq(t) => t.spans[0],
        syn::BinOp::Lt(t) => t.span,
        syn::BinOp::Le(t) => t.spans[0],
        syn::BinOp::Ne(t) => t.spans[0],
        syn::BinOp::Ge(t) => t.spans[0],
        syn::BinOp::Gt(t) => t.span,
        syn::BinOp::AddAssign(t) => t.spans[0],
        syn::BinOp::SubAssign(t) => t.spans[0],
        syn::BinOp::MulAssign(t) => t.spans[0],
        syn::BinOp::DivAssign(t) => t.spans[0],
        syn::BinOp::RemAssign(t) => t.spans[0],
        syn::BinOp::BitXorAssign(t) => t.spans[0],
        syn::BinOp::BitAndAssign(t) => t.spans[0],
        syn::BinOp::BitOrAssign(t) => t.spans[0],
        syn::BinOp::ShlAssign(t) => t.spans[0],
        syn::BinOp::ShrAssign(t) => t.spans[0],
        _ => proc_macro2::Span::call_site(),
    }
}

fn unop_span(op: &syn::UnOp) -> proc_macro2::Span {
    match op {
        syn::UnOp::Deref(t) => t.span,
        syn::UnOp::Not(t) => t.span,
        syn::UnOp::Neg(t) => t.span,
        _ => proc_macro2::Span::call_site(),
    }
}

fn range_limits_span(limits: &syn::RangeLimits) -> proc_macro2::Span {
    match limits {
        syn::RangeLimits::HalfOpen(t) => t.spans[0],
        syn::RangeLimits::Closed(t) => t.spans[0],
    }
}

fn lit_span(lit: &syn::Lit) -> proc_macro2::Span {
    match lit {
        syn::Lit::Str(l) => l.span(),
        syn::Lit::ByteStr(l) => l.span(),
        syn::Lit::CStr(l) => l.span(),
        syn::Lit::Byte(l) => l.span(),
        syn::Lit::Char(l) => l.span(),
        syn::Lit::Int(l) => l.span(),
        syn::Lit::Float(l) => l.span(),
        syn::Lit::Bool(l) => l.span,
        syn::Lit::Verbatim(l) => l.span(),
        _ => proc_macro2::Span::call_site(),
    }
}

fn type_span(ty: &syn::Type) -> proc_macro2::Span {
    match ty {
        syn::Type::Path(t) => t
            .path
            .segments
            .last()
            .map(|s| s.ident.span())
            .unwrap_or_else(proc_macro2::Span::call_site),
        syn::Type::Reference(t) => t.and_token.span,
        syn::Type::Slice(t) => t.bracket_token.span.join(),
        syn::Type::Array(t) => t.bracket_token.span.join(),
        syn::Type::Tuple(t) => t.paren_token.span.join(),
        syn::Type::BareFn(t) => t.fn_token.span,
        syn::Type::ImplTrait(t) => t.impl_token.span,
        syn::Type::TraitObject(t) => t
            .dyn_token
            .map(|d| d.span)
            .unwrap_or_else(proc_macro2::Span::call_site),
        syn::Type::Never(t) => t.bang_token.span,
        syn::Type::Ptr(t) => t.star_token.span,
        syn::Type::Paren(t) => t.paren_token.span.join(),
        syn::Type::Infer(t) => t.underscore_token.span,
        _ => proc_macro2::Span::call_site(),
    }
}

#[allow(dead_code)]
fn expr_span(expr: &syn::Expr) -> proc_macro2::Span {
    match expr {
        syn::Expr::Lit(e) => lit_span(&e.lit),
        syn::Expr::Path(e) => e
            .path
            .segments
            .last()
            .map(|s| s.ident.span())
            .unwrap_or_else(proc_macro2::Span::call_site),
        syn::Expr::Call(e) => e.paren_token.span.join(),
        syn::Expr::MethodCall(e) => e.method.span(),
        syn::Expr::Binary(e) => binop_span(&e.op),
        syn::Expr::Unary(e) => unop_span(&e.op),
        syn::Expr::Block(e) => e.block.brace_token.span.join(),
        syn::Expr::If(e) => e.if_token.span,
        syn::Expr::Match(e) => e.match_token.span,
        _ => proc_macro2::Span::call_site(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_json(source: &str) -> Value {
        let json_str = parse_rust_source(source).expect("parse should succeed");
        serde_json::from_str(&json_str).expect("JSON should be valid")
    }

    #[test]
    fn test_parse_main_fn() {
        let json = parse_json("fn main() {}");
        assert_eq!(json["type"], "File");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "ItemFn");
        assert_eq!(items[0]["ident"], "main");
    }

    #[test]
    fn test_parse_struct_with_named_field() {
        let json = parse_json("struct Foo { x: i32 }");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemStruct");
        assert_eq!(items[0]["ident"], "Foo");
        let fields = items[0]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0]["ident"], "x");
    }

    #[test]
    fn test_parse_enum_with_variants() {
        let json = parse_json("enum Color { Red, Blue }");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemEnum");
        assert_eq!(items[0]["ident"], "Color");
        let variants = items[0]["variants"].as_array().unwrap();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0]["ident"], "Red");
        assert_eq!(variants[1]["ident"], "Blue");
    }

    #[test]
    fn test_parse_use_statement() {
        let json = parse_json("use std::io::Read;");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemUse");
        let tree = &items[0]["tree"];
        assert_eq!(tree["type"], "UsePath");
        assert_eq!(tree["ident"], "std");
    }

    #[test]
    fn test_async_unsafe_fn_sig() {
        let json = parse_json("async unsafe fn f() -> Result<T, E> {}");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemFn");
        assert_eq!(items[0]["ident"], "f");
        let sig = &items[0]["sig"];
        assert_eq!(sig["async"], true);
        assert_eq!(sig["unsafe"], true);
        assert!(!items[0]["sig"]["output"].is_null());
    }

    #[test]
    fn test_invalid_rust_returns_error() {
        let result = parse_rust_source("fn { broken syntax");
        assert!(result.is_err(), "Invalid Rust should return an error");
    }

    #[test]
    fn test_span_has_line_col() {
        let json = parse_json("fn hello() {}");
        let items = json["items"].as_array().unwrap();
        let span = &items[0]["span"];
        assert!(span["start"]["line"].is_number());
        assert!(span["start"]["col"].is_number());
        assert!(span["end"]["line"].is_number());
        assert!(span["end"]["col"].is_number());
        assert_eq!(span["start"]["line"], 1);
    }

    #[test]
    fn test_pub_visibility() {
        let json = parse_json("pub fn public_fn() {}");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["vis"], "pub");
    }

    #[test]
    fn test_struct_tuple_fields() {
        let json = parse_json("struct Point(f64, f64);");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemStruct");
        let fields = items[0]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 2);
    }

    #[test]
    fn test_impl_block() {
        let json = parse_json(
            "struct Foo;\nimpl Foo { fn bar(&self) {} }",
        );
        let items = json["items"].as_array().unwrap();
        let impl_item = items.iter().find(|i| i["type"] == "ItemImpl").unwrap();
        assert!(!impl_item["items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_trait_definition() {
        let json = parse_json("trait Greet { fn hello(&self); }");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemTrait");
        assert_eq!(items[0]["ident"], "Greet");
    }

    #[test]
    fn test_const_item() {
        let json = parse_json("const MAX: u32 = 100;");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemConst");
        assert_eq!(items[0]["ident"], "MAX");
    }

    #[test]
    fn test_static_item() {
        let json = parse_json("static mut COUNTER: u32 = 0;");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemStatic");
        assert_eq!(items[0]["ident"], "COUNTER");
        assert_eq!(items[0]["mutability"], "mut");
    }

    #[test]
    fn test_type_alias() {
        let json = parse_json("type Result<T> = std::result::Result<T, Error>;");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemType");
        assert_eq!(items[0]["ident"], "Result");
    }

    #[test]
    fn test_attribute_derive() {
        let json = parse_json("#[derive(Debug, Clone)]\nstruct Foo;");
        let items = json["items"].as_array().unwrap();
        let attrs = items[0]["attrs"].as_array().unwrap();
        assert_eq!(attrs[0]["type"], "Attribute");
        assert_eq!(attrs[0]["style"], "outer");
        assert_eq!(attrs[0]["path"], "derive");
        assert!(attrs[0]["tokens"].as_str().unwrap().contains("Debug"));
    }

    #[test]
    fn test_closure_expression() {
        let json = parse_json("fn f() { let c = |x| x + 1; }");
        let items = json["items"].as_array().unwrap();
        let block = &items[0]["block"];
        let stmts = block["stmts"].as_array().unwrap();
        assert_eq!(stmts[0]["type"], "StmtLocal");
        let init = &stmts[0]["init"];
        assert_eq!(init["type"], "ExprClosure");
    }

    #[test]
    fn test_match_expression() {
        let json = parse_json(
            r#"fn f() {
                match x {
                    1 => "one",
                    _ => "other",
                }
            }"#,
        );
        let items = json["items"].as_array().unwrap();
        let block = &items[0]["block"];
        let stmts = block["stmts"].as_array().unwrap();
        assert_eq!(stmts[0]["type"], "ExprMatch");
        let arms = stmts[0]["arms"].as_array().unwrap();
        assert_eq!(arms.len(), 2);
    }

    #[test]
    fn test_module_with_content() {
        let json = parse_json("mod inner { fn x() {} }");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemMod");
        assert_eq!(items[0]["ident"], "inner");
        let content = items[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "ItemFn");
    }

    #[test]
    fn test_use_group() {
        let json = parse_json("use std::io::{Read, Write};");
        let items = json["items"].as_array().unwrap();
        let tree = &items[0]["tree"];
        assert_eq!(tree["type"], "UsePath");
        assert_eq!(tree["ident"], "std");
        let io = &tree["tree"];
        assert_eq!(io["type"], "UsePath");
        assert_eq!(io["ident"], "io");
        let group = &io["tree"];
        assert_eq!(group["type"], "UseGroup");
        let group_items = group["items"].as_array().unwrap();
        assert_eq!(group_items.len(), 2);
    }

    #[test]
    fn test_generic_struct() {
        let json = parse_json("struct Wrapper<T: Clone> { inner: T }");
        let items = json["items"].as_array().unwrap();
        assert_eq!(items[0]["type"], "ItemStruct");
        let generics = &items[0]["generics"];
        let params = generics["params"].as_array().unwrap();
        assert_eq!(params.len(), 1);
        assert_eq!(params[0]["type"], "TypeParam");
        assert_eq!(params[0]["ident"], "T");
    }

    #[test]
    fn test_enum_with_data() {
        let json = parse_json("enum Shape { Circle(f64), Rect { w: f64, h: f64 } }");
        let items = json["items"].as_array().unwrap();
        let variants = items[0]["variants"].as_array().unwrap();
        let circle = &variants[0];
        assert_eq!(circle["ident"], "Circle");
        assert_eq!(circle["fields"].as_array().unwrap().len(), 1);
        let rect = &variants[1];
        assert_eq!(rect["ident"], "Rect");
        assert_eq!(rect["fields"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn test_for_loop() {
        let json = parse_json("fn f() { for i in 0..10 { } }");
        let items = json["items"].as_array().unwrap();
        let stmts = items[0]["block"]["stmts"].as_array().unwrap();
        assert_eq!(stmts[0]["type"], "ExprForLoop");
    }

    #[test]
    fn test_method_call() {
        let json = parse_json("fn f() { v.push(1); }");
        let items = json["items"].as_array().unwrap();
        let stmts = items[0]["block"]["stmts"].as_array().unwrap();
        assert_eq!(stmts[0]["type"], "ExprMethodCall");
        assert_eq!(stmts[0]["method"], "push");
    }

    #[test]
    fn test_trait_impl() {
        let json = parse_json(
            "struct Foo;\ntrait Bar { fn bar(&self); }\nimpl Bar for Foo { fn bar(&self) {} }",
        );
        let items = json["items"].as_array().unwrap();
        let impl_item = items.iter().find(|i| i["type"] == "ItemImpl").unwrap();
        assert!(!impl_item["trait_"].is_null());
    }

    #[test]
    fn test_reference_type() {
        let json = parse_json("fn f(x: &mut String) {}");
        let items = json["items"].as_array().unwrap();
        let sig = &items[0]["sig"];
        let inputs = sig["inputs"].as_array().unwrap();
        let ty = &inputs[0]["ty"];
        assert_eq!(ty["type"], "TypeReference");
        assert_eq!(ty["mutability"], "mut");
    }

    #[test]
    fn test_async_block() {
        let json = parse_json("fn f() { async move { 42 }; }");
        let items = json["items"].as_array().unwrap();
        let stmts = items[0]["block"]["stmts"].as_array().unwrap();
        assert_eq!(stmts[0]["type"], "ExprAsync");
        assert_eq!(stmts[0]["capture"], "move");
    }

    #[test]
    fn test_try_operator() {
        let json = parse_json("fn f() -> Result<(), ()> { let x = foo()?; Ok(()) }");
        let items = json["items"].as_array().unwrap();
        let stmts = items[0]["block"]["stmts"].as_array().unwrap();
        let init = &stmts[0]["init"];
        assert_eq!(init["type"], "ExprTry");
    }
}
