//! Generate direct calls from the shared Rust API, so adding a public method
//! cannot silently leave it unavailable on the phone.
use quote::{ToTokens, quote};
use std::{env, fs, path::PathBuf};
use syn::{FnArg, ImplItem, Item, Pat, ReturnType, Type, Visibility};

fn owned(ty: &Type) -> proc_type::Owned {
    match ty {
        Type::Reference(reference) => {
            let inner = &*reference.elem;
            let value = match inner {
                Type::Slice(slice) => {
                    let elem = &slice.elem;
                    quote!(Vec<#elem>)
                }
                _ if inner.to_token_stream().to_string() == "str" => quote!(String),
                _ if inner.to_token_stream().to_string() == "Path" => quote!(PathBuf),
                _ => quote!(#inner),
            };
            proc_type::Owned {
                spelling: value.to_string(),
                borrow: true,
                optional_borrow: false,
            }
        }
        Type::Path(path) if path.path.segments.last().unwrap().ident == "Option" => {
            let syn::PathArguments::AngleBracketed(args) =
                &path.path.segments.last().unwrap().arguments
            else {
                panic!("Option arguments")
            };
            let syn::GenericArgument::Type(inner) = args.args.first().unwrap() else {
                panic!("Option type")
            };
            let inner = owned(inner);
            proc_type::Owned {
                spelling: format!("Option<{}>", inner.spelling),
                borrow: false,
                optional_borrow: inner.borrow,
            }
        }
        _ => proc_type::Owned {
            spelling: ty.to_token_stream().to_string(),
            borrow: false,
            optional_borrow: false,
        },
    }
}
mod proc_type {
    pub struct Owned {
        pub spelling: String,
        pub borrow: bool,
        pub optional_borrow: bool,
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=DJBOOTH_BUILD_ID");
    println!(
        "cargo:rustc-env=DJBOOTH_BUILD_ID={}",
        env::var("DJBOOTH_BUILD_ID").unwrap_or_else(|_| "development-unidentified".into())
    );
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let shared = manifest.join("../djtools-link/src");
    let mut methods = Vec::new();
    let mut functions = Vec::new();
    for filename in ["djlink.rs", "ids.rs", "library.rs", "remote_db_audit.rs"] {
        let path = shared.join(filename);
        println!("cargo:rerun-if-changed={}", path.display());
        let file = syn::parse_file(&fs::read_to_string(path).unwrap()).unwrap();
        for item in file.items {
            match item {
                Item::Impl(block)
                    if block.self_ty.to_token_stream().to_string() == "DjLinkServer" =>
                {
                    for item in block.items {
                        if let ImplItem::Fn(method) = item
                            && matches!(method.vis, Visibility::Public(_))
                        {
                            methods.push(method.sig);
                        }
                    }
                }
                Item::Fn(function) if matches!(function.vis, Visibility::Public(_)) => {
                    functions.push(function.sig)
                }
                _ => {}
            }
        }
    }
    let special = [
        "new",
        "start",
        "stop",
        "subscribe_telemetry",
        "subscribe_mixer_telemetry",
        "subscribe_vu_telemetry",
    ];
    let mut generated =
        String::from("// Generated from djtools-link public signatures. Do not edit.\n");
    let mut schema = Vec::new();
    let mut swift = String::from(
        "// Generated from djtools-link by djbooth-mobile/build.rs. Do not edit.\n#if os(iOS)\n",
    );
    for (kind, signatures, enum_name) in [
        ("server", &methods, "DJLinkServerMethod"),
        ("function", &functions, "DJLinkFunction"),
    ] {
        swift.push_str(&format!(
            "enum {enum_name}: String, CaseIterable, Sendable {{\n"
        ));
        let params = if kind == "server" {
            "server: &DjLinkServer, "
        } else {
            ""
        };
        generated.push_str(&format!("pub(crate) async fn invoke_{kind}({params}operation: &str, input: &str) -> Result<Value> {{ match operation {{\n"));
        for sig in signatures {
            let name = sig.ident.to_string();
            swift.push_str(&format!("    case `{name}`\n"));
            let mut fields = Vec::new();
            let mut values = Vec::new();
            let mut arguments = Vec::new();
            for argument in &sig.inputs {
                if let FnArg::Typed(argument) = argument {
                    let Pat::Ident(id) = &*argument.pat else {
                        panic!("unsupported argument in {name}")
                    };
                    let id = id.ident.to_string();
                    let ty = owned(&argument.ty);
                    fields.push(format!("{id}: {}", ty.spelling));
                    values.push(if ty.optional_borrow {
                        format!("args.{id}.as_deref()")
                    } else if ty.borrow {
                        format!("&args.{id}")
                    } else {
                        format!("args.{id}")
                    });
                    arguments.push(serde_json::json!({"name": id, "type": argument.ty.to_token_stream().to_string()}));
                }
            }
            schema.push(serde_json::json!({"operation": format!("{kind}.{name}"), "arguments": arguments, "returns": sig.output.to_token_stream().to_string()}));
            if kind == "server" && special.contains(&name.as_str()) {
                continue;
            }
            let receiver = if kind == "server" {
                "server."
            } else {
                "djtools_link::"
            };
            let asynchronous = if sig.asyncness.is_some() {
                ".await"
            } else {
                ""
            };
            let fallible = match &sig.output {
                ReturnType::Type(_, ty) => match &**ty {
                    Type::Path(p) => matches!(
                        p.path.segments.last().unwrap().ident.to_string().as_str(),
                        "Result" | "LinkResult"
                    ),
                    _ => false,
                },
                _ => false,
            };
            let question = if fallible { "?" } else { "" };
            generated.push_str(&format!("\"{name}\" => {{ #[derive(serde::Deserialize)] #[serde(deny_unknown_fields)] struct Args {{ {} }} let args: Args = serde_json::from_str(input)?; let _ = &args; Ok(serde_json::to_value({receiver}{name}({}){asynchronous}{question})?) }},\n", fields.join(","), values.join(",")));
        }
        generated.push_str("_ => anyhow::bail!(\"Unknown DJ Link operation: {operation}\"), } }\n");
        swift.push_str("}\n");
    }
    swift.push_str("#endif\n");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("dispatch.rs"), generated).unwrap();
    fs::write(
        out.join("api.json"),
        serde_json::to_string_pretty(&schema).unwrap(),
    )
    .unwrap();
    fs::write(out.join("DJLinkMethods.swift"), swift).unwrap();
}
